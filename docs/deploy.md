# API デプロイ方式（T-020 設計）

`ninja-habits` の API（Node ESM, `dist-api/server.js`）を `ninja-habits-infra` の
ALB + ASG(EC2) 構成へ配布・更新する方式の設計と現在の実装状況のメモ。
T-020（方式設計）は合意済み。T-030 のうち CDK 側（NetworkStack 分割 / user-data 置換 / IAM / SSM パラメータ所有 / deploy script 分割 / `set-api-artifact.sh`）は **実装済み**。残るは AWS への実デプロイと CI 配線（§未決事項）。

## 現状

- api-stack: NetworkStack 参照の VPC + ALB + ASG(LaunchTemplate, Amazon Linux 2023)。
  **user-data は実 API（Node 20 + S3 pull + env 組立 + systemd）に置換済み**。インスタンスロールと `Role=ninja-habits-api` タグも付与済み。**未デプロイ**。
- API 成果物: `npm run api:build` → `dist-api/*.js`(ESM)。起動は `node dist-api/server.js`、migration は `node dist-api/migrate.js`。
  - dependencies は **`pg` のみ**（`react`/`react-dom` は devDependencies へ移動済み）。よって `npm ci --omit=dev` で API 箱に必要な依存だけが揃う。
  - `npm run api:build` は tsc に加え `api:copy-migrations`（`api/migrations/*.sql` → `dist-api/migrations/`）を実行する。runner は実行時に `dist-api/migrations/*.sql` を読む。
  - `engines.node` は `">=20 <21"` に固定済み。
- 必要 env: `COGNITO_ISSUER`/`COGNITO_CLIENT_ID`/`API_ALLOWED_ORIGIN`/`PORT=8080`/`DATABASE_URL`。
  `API_DEV_AUTH` は本番で未設定（`assertSafeConfig` が issuer 併用を起動時に拒否）。

## 採用方式（推奨）

**CI ビルド → S3 配布 → EC2 が起動時に pull → systemd で起動**。
現行の EC2/ASG + user-data に最小変更で乗り、AMI パイプライン不要。

### 1. アーティファクト
- 形式: `ninja-habits-api-<version>.tgz`。中身:
  - `dist-api/`（コンパイル済み JS）
  - `dist-api/migrations/`（`npm run api:build` 内の `api:copy-migrations` で `api/migrations/*.sql` を出力。runner が実行時に読む）
  - `package.json`
  - 本番 `node_modules`（dependencies は `pg` のみ）
- 本番依存をバンドルし、**起動時に npm を叩かない**（boot の確実性を優先。Node ランタイムのみ別途用意）。
- 生成（CI）:
  1. `npm ci` → `npm test` → `npm run api:build`（tsc + SQL コピー）
  2. `npm ci --omit=dev`（dependencies は pg のみなので、これだけで本番 node_modules が揃う）
  3. `dist-api/` + `package.json` + `node_modules` を tar
- 配置: S3（非公開・バージョニング有効）。キー例 `s3://ninja-habits-artifacts-<stage>/api/<version>.tgz`。
- 現在バージョンの指定: SSM Parameter `/ninja-habits/<stage>/api/artifact-key` に現行 S3 キーを保持。
  EC2 は起動時にこれを読んで対象 tgz を取得する（LaunchTemplate を変えずにリリースできる）。

### 2. Node ランタイム
- Amazon Linux 2023 の `dnf install -y nodejs`（Node 20 系）。メジャー版は `package.json` の `engines.node`（`">=20 <21"`、固定済み）に合わせる。
- 将来: 起動高速化・不変性が要るなら Packer で Node+成果物を焼いた AMI に切替（後述「代替案」）。

### 3. 起動・プロセス管理
- nginx プレースホルダは撤去。**Node が直接 `PORT=8080` を listen し、ALB ターゲット = 8080**（`/health` は API 実装済み）。
- `systemd` ユニット `ninja-habits-api.service`:
  - `ExecStart=/usr/bin/node /opt/ninja-habits-api/dist-api/server.js`
  - `EnvironmentFile=/etc/ninja-habits-api.env`、`Restart=always`、専用ユーザーで実行。
- user-data の流れ: nodejs 導入 → SSM から artifact-key 取得 → S3 から tgz 取得・展開 → env ファイル生成 → unit 配置 → `systemctl enable --now`。

### 4. 設定・シークレット
- 非機密（`COGNITO_ISSUER`/`COGNITO_CLIENT_ID`/`API_ALLOWED_ORIGIN`/`PORT`）: SSM Parameter Store（String）。
- **SSM パラメータの所有（実装済み）**: 値が CDK で確定するものは各スタックが作成し、可変のものだけ手動/CI で投入する。
  - `/<stage>/api/cognito-issuer`・`/cognito-client-id`: **AuthStack** が作成（user pool / client から導出）。
  - `/<stage>/api/allowed-origin`: **NetworkStack** が `config.api.apiAllowedOrigin` から作成（dev=`http://localhost:5173`、prod は本番 Web オリジンに要差し替え）。
  - `/<stage>/db/endpoint`・`/name`・`/secret-arn`: **DatabaseStack** が作成。
  - `/<stage>/api/artifact-key`: **CDK では作らない**（リリース毎に変わるため CDK 管理だと deploy で巻き戻る）。`scripts/set-api-artifact.sh`（CI）で put する。
  - `PORT` は user-data が config の `appPort` から env に直接書く（SSM 不要）。
- `DATABASE_URL` の組み立て（出所を固定。P2）:
  - **host**: SSM Parameter `/ninja-habits/<stage>/db/endpoint`（database-stack の `DatabaseEndpointAddress` 出力を投入）
  - **port**: `5432` 固定（必要なら SSM 化）
  - **dbname**: SSM Parameter `/ninja-habits/<stage>/db/name`（config の `databaseName`）
  - **user / password**: Secrets Manager（database-stack の `DatabaseSecretArn`）の JSON フィールド `username` / `password`
  - **SSL**: RDS なので `sslmode=require&uselibpqcompat=true` を付与（`pg`/`pg-connection-string` が `sslmode=require` を `verify-full` 扱いにして RDS CA 検証で落ちるのを避け、libpq 互換の require として扱う）
  - 形: `postgresql://<user>:<pass>@<host>:5432/<dbname>?sslmode=require&uselibpqcompat=true`
  - **user / password は URL エンコードしてから組み立てる**（`encodeURIComponent` 相当）。現状の admin secret は URL 危険文字を除外しているが（database-stack の `excludeCharacters`）、エンコードを常に通す契約にして将来のシークレット変更に強くする。
  - 代替（より堅い）: `DATABASE_URL` を組まず、`PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`/`PGSSLMODE` を env で渡す手もある（要 app 側で connectionString 未指定時のフォールバック対応）。今回は `DATABASE_URL` 方式を採用。
  - ※ この admin secret は `username`/`password` のみを持ち、host/port/dbname は含まない前提（RDS は別 output）。
- IAM: インスタンスロールに `ssm:GetParameter`（`/ninja-habits/<stage>/*`）、
  `s3:GetObject`（成果物バケット）、`secretsmanager:GetSecretValue`（DB シークレット ARN）を付与。
- `API_DEV_AUTH` は付与しない。

### 5. DB migration
- **起動毎には実行しない**（ASG 複数同時起動の競合を避ける）。
- リリース時の明示ステップとして **今回リリースする新 artifact の** `dist-api/migrate.js` を RDS に対して実行。
- **実行経路は SSM Run Command を第一候補**とする（RDS は private subnet。GitHub Actions ランナーから直接到達できないため）。
  - フロー: CI の deploy ロールが `ssm:SendCommand` で API インスタンス 1 台を対象に、
    **新 artifact を S3 から一時ディレクトリへ download/extract し、その `dist-api/migrate.js` を実行**（既存インスタンス上の旧 artifact では実行しない）。`ssm:GetCommandInvocation` で結果待ち。
    - SSM コマンドは「新 artifact の S3 キー」を引数で受け取り、`mktemp -d` → S3 取得 → 展開 → DB 接続 env を組み立て → `node <tmp>/dist-api/migrate.js` の順。
    - これにより artifact-key 更新前でも、新 SQL が確実に適用される（§6 の順序とも整合）。
  - 対象インスタンス選定: ASG タグ `Role=ninja-habits-api` + `Stage=<stage>`（**実装で付与済み**）の running 候補と、SSM `PingStatus=Online` の積集合から 1 台。先頭が未登録（instance refresh 中など）でも他の Online を拾え、別ステージを誤って選ばない。
  - 実装: `scripts/run-migration.sh`（`npm run migrate-api:<stage> -- <s3-key>`）。対象へ `send-command` し、結果待ち・成否で exit code を返す（失敗時は promote しない）。値は base64 で remote shell に渡し、artifact key 由来の injection を防ぐ。
  - 代替: VPC 内に専用の一時 migration タスク（CodeBuild in-VPC 等）を置く案もあるが、追加構成が要るため後回し。
- runner は `schema_migrations` で冪等。**forward-only**（down は持たない）。破壊的変更は expand/contract で段階適用する。
- 順序: 新 artifact を S3 へ upload → その artifact で migrate（後方互換な変更）→ artifact-key 更新 → instance refresh。

### 6. 初回デプロイ / ブートストラップ（first deploy）

> **artifact-key の promote 順序（重要）**: 初回と通常リリースで順序が逆になる。
> - **初回（このセクション）**: インスタンスがまだ無く migration は ASG 作成後にしか流せないため、**promote 済み artifact で Api を初回起動 → その後 migrate**。
> - **通常リリース（§6.1）**: 既存インスタンスがあるため、**migrate 成功後に promote → instance refresh**。promote を先に行うと、migration 失敗時に ASG 交換/再起動が未 migrate DB に新コードを乗せる危険がある。
> `set-api-artifact.sh` は `upload` と `promote` を分離しており、この順序差を呼び出し側で守る。

**stack 構成の前提（実装済み）**: 共有資源（VPC / SG / 成果物 S3 / 基盤 SSM）を **NetworkStack** に集約し、database / api の両方がそれを参照する（依存の根は NetworkStack）。これにより「DB を先に作ってから api を起動」が可能になっている。`/health` は `SELECT 1` を実行するため、DB が存在しないと api インスタンスは health を通らない点に注意。

初回手順。`deploy:<stage>` バンドルは **Database までで止め**、ApiStack は artifact 投入後に明示デプロイする（`deploy:<stage>:api`）。これにより artifact-key / SSM が未投入のまま Api が起動して user-data が落ちるのを防ぐ:

1. **Hosting / Auth / Network / Database をデプロイ**（`npm run deploy:<stage>`）。
   - この時点で `cognito-issuer`/`cognito-client-id`（Auth）、`allowed-origin`（Network）、`db/endpoint`・`db/name`・`db/secret-arn`（Database）の SSM は確定する。成果物 S3 バケットも作成済み。
2. **新 artifact を S3 アップロードし、`artifact-key` を promote**（初回はこの順で可。リリース時は §6.1 の通り promote を migration 後にずらす）:
   - `npm run set-api-artifact:<stage> -- upload <path-to-tgz>` → 出力された S3 key を控える
   - `npm run set-api-artifact:<stage> -- promote <s3-key>`
3. （DatabaseStack はステップ1で作成済み。secret ARN は `db/secret-arn` SSM と ApiStack へ渡す `databaseSecret` の scoped grant で参照する。）
4. **ApiStack をデプロイ**（`npm run deploy:<stage>:api`）。user-data は artifact を pull → env（DB endpoint/secret 等）を組み立て → systemd 起動。DB・SSM・artifact は既に存在するので起動可。
   - DB は未マイグレートだが `/health` の `SELECT 1` は通る（接続成功、テーブル不問）ため ELB ヘルスチェックは PASS し InService になる。`/v1/*` は migration 後に 200。
5. 対象インスタンスが **SSM online** になるのを待つ
6. **新 artifact で migration を実行**: `npm run migrate-api:<stage> -- <s3-key>`（§5 の SSM Run Command）
7. **ALB 経由で API 動作確認**（`/v1/me` 等が 200）
- 以降は §6.1 の通常リリースに移行する。

> 軽量代替（NetworkStack を切らない場合）: api-stack の ASG を初回 `desiredCapacity=0` でデプロイ→database-stack→SSM 投入→ASG をスケールアップ、で順序を作る手もある。ただし依存方向（database→api）は現状のままで、secret/endpoint の受け渡しは別途必要。NetworkStack 分割の方が後続も素直なため第一候補とする。

> 露出の留意: 初回はごく短時間「未マイグレート API が公開」されうる。dev では許容。prod 公開時は (a) 先に最小1台で migration→スケールアウト、(b) ALB リスナーを後段で有効化、で回避（T-019 と合わせて検討）。

### 6.1 リリース/更新フロー（instance refresh）

通常リリースは **promote を migration 成功後に行う**（初回 §6 と逆順）。

1. CI: build → test → package → **新 artifact を S3 アップロード**（`set-api-artifact.sh upload`。バージョン付きキーを出力。**まだ promote しない**）
2. **新 artifact で migration 実行**（`run-migration.sh`。SSM Run Command が S3 から新 artifact を取得して実行。§5。後方互換前提）
3. migration 成功後に **`artifact-key` を新キーへ promote**（`set-api-artifact.sh promote <key>`）
4. ASG の **instance refresh** をトリガ（`refresh-api.sh`。新インスタンスが新成果物を pull）。ELB ヘルスチェックで段階入替（`deregistrationDelay=30s` 設定済み）。スクリプトは終端状態までポーリングし exit code を返す（`0`=成功 / `1`=失敗・rollback / `2`=`MAX_WAIT` 到達でまだ進行中）。**再実行は冪等**で、進行中の refresh を拾って継続ポーリングするため、`exit 2` 後の rerun でも二重起動しない。CI は単一ステップなら `MAX_WAIT` を十分大きく取るか、`exit 2` を「進行中」として扱う。
5. ロールバック: `artifact-key` を前バージョンへ promote し直して再 refresh（`set-api-artifact.sh promote <prev>` → `refresh-api.sh`。migration は forward-only のため、スキーマは後方互換で運用）。

### 7. CI
- GitHub Actions（リポジトリは GitHub）。**OIDC で AWS デプロイ用ロールを assume**（静的キーを置かない）。
- デプロイロール権限: S3 put、SSM `PutParameter`、ASG `StartInstanceRefresh` + `DescribeInstanceRefreshes`、migration/対象選定用の `ssm:SendCommand` + `ssm:GetCommandInvocation` + `ssm:DescribeInstanceInformation` + `ec2:DescribeInstances`、ASG 名/バケット解決用の `cloudformation:DescribeStacks`。
- **ステージ単位の直列化（必須）**: release ジョブに stage 単位の `concurrency`（例 `group: release-${stage}`, `cancel-in-progress: false`）を付け、同一ステージの release を同時に走らせない。`refresh-api.sh` は進行中 refresh を再利用するため、別 release が重なると前 release の refresh（旧 artifact 対象）を拾い、新 artifact への全台入替を保証できない。upload→migrate→promote→refresh の一連が 1 release 内で順に完了することを前提にする。

#### 実装（CicdStack + workflow）
- **CicdStack（`NinjaHabits-Cicd`, account 単位）**: GitHub OIDC provider + release ロール `ninja-habits-ci-release`。`npm run deploy:cicd` で 1 回デプロイ。出力 `ReleaseRoleArn` を repo secret `NINJA_HABITS_AWS_DEPLOY_ROLE_ARN` に設定する。
  - OIDC trust: `repo:yuya-nakashima/ninja-habits-infra:*`（後で branch/environment に絞れる）。
  - ロール権限は release flow に限定（cdk deploy や DB secret 取得は含まない。後者は instance ロール）。S3=`ninja-habits-api-artifacts-*`（put + multipart）、SSM PutParameter=`/ninja-habits/*/api/artifact-key`（DB 等の他パラメータは触れない）、SendCommand=`AWS-RunShellScript` + `Role=ninja-habits-api` タグのインスタンス、ASG refresh=`NinjaHabits-*`。
  - `maxSessionDuration=2h`（refresh の最大待ちを含む release 全体をカバー）。
  - OIDC provider は account 1 つ。既存があれば `--context oidcProviderArn=arn:...` で import。
- **workflow `.github/workflows/release-api.yml`（infra repo）**: `workflow_dispatch`（inputs: `stage`, `app_ref`）、stage 単位 concurrency、OIDC。app repo を checkout して artifact をビルド（`npm ci`→`test`→`api:build`→`npm ci --omit=dev`→tar）→ **ビルド後に AWS 認証を assume**（`role-duration-seconds=7200`。遅い build/test が認証ウィンドウを食わないように）→ `upload`→`run-migration`→`promote`→`refresh` を順に実行。
  - 必要 secret: `NINJA_HABITS_AWS_DEPLOY_ROLE_ARN`、`NINJA_HABITS_APP_REPO_TOKEN`（private な ninja-habits を checkout するため）。
  - artifact key は app の short SHA から決定的（`api/ninja-habits-api-<sha>.tgz`）なので、各ステップは key を解決し直さず共有できる。
  - refresh は `MAX_WAIT=2400` で exit 2 を回避。

## 停止 / 削除（dev のコスト停止）

dev で継続課金が出るのは **Network（NAT GW ~ $33/mo + 通信）**、**Database（RDS t4g.micro + storage + backup）**、**Api（ALB ~ $16/mo + EC2 t3.micro）**。
NAT GW・ALB は「停止」が無く削除のみ、RDS の stop は最長7日で自動再開＋storage 課金継続のため、**dev はコストを止めたいなら削除する**。

- 削除（依存の逆順。まとめて指定すれば cdk が順序解決）:
  `npm run destroy:dev:billable`（= `cdk destroy NinjaHabits-dev-Api NinjaHabits-dev-Database NinjaHabits-dev-Network --context stage=dev`）
  - dev Database は `removalPolicy=destroy`（snapshot 無し）→ **データ・secret は消える**（dev 前提）。
  - dev artifact バケットは `autoDeleteObjects`+`DESTROY` で中身ごと削除。
- **残す（課金ほぼ無し）**: `NinjaHabits-Cicd`（IAM/OIDC=無料）、`*-dev-Auth`（Cognito 無料枠）、`*-dev-Hosting`（S3+CloudFront 数円）。消すと再設定が要るので通常は残す。
- **再構築**: `npm run deploy:dev`（Network/Database 再作成）→ artifact を再 `upload`/`promote`（バケット名は決定的だが中身は消えているため再 upload 必須。`artifact-key` SSM は CDK 外なので残るが指す先が空になる）→ `deploy:dev:api` → `migrate-api:dev`。
- **prod 注意**: Database は `deletionProtection=true` + `removalPolicy=snapshot`。`cdk destroy` はそのままでは保護で止まり、外すと snapshot を取得して削除。意図的な削除時のみ protection を外す。

## 代替案（今回は不採用、将来検討）
- **AMI 焼き込み（Packer）**: 起動が速く不変。リリース毎の AMI ビルドと LaunchTemplate 更新が要る。トラフィック増/起動頻度が上がったら移行。
- **コンテナ（ECR + ECS/Fargate）**: スケール・運用は楽だが、現行 EC2/ASG からの構成変更が大きい。Paid 規模化で再検討。

## スタック構成（実装済み）

依存の根を **NetworkStack** に集約済み（旧構成の database → api / api が VPC/SG 所有 を反転）。現在の構成:

- **NetworkStack（新規）**: VPC、`apiInstanceSecurityGroup`、`albSecurityGroup`（および SG 間 ingress）、
  成果物 S3 バケット、基盤 SSM パラメータ（`api/allowed-origin`）。`api/artifact-key` は CDK 非管理（§4）。依存の根。
- **DatabaseStack**: NetworkStack の VPC/SG を参照。RDS + admin secret を生成し、
  `endpoint`/`dbname` を SSM へ、secret ARN を SSM か export で公開（api が起動時に参照）。
- **ApiStack**: NetworkStack の VPC/SG/バケット/SSM と DatabaseStack の DB 参照を消費。ALB + ASG のみ。
- デプロイ順: **Network → Database → Api**（`bin/app.ts` の参照配線もこの向きに修正）。

### api-stack の変更（実装済み）
- user-data: nginx 撤去 → Node 20 導入 + S3 pull + env 組立（DB endpoint/secret/SSM）+ systemd 起動へ置換済み。
- インスタンスロール: `s3:GetObject`（成果物）、`ssm:GetParameter`、`secretsmanager:GetSecretValue`、
  および **SSM Run Command 用に `AmazonSSMManagedInstanceCore`**（SSM Agent は AL2023 にプリインストール、egress は private+NAT で到達可）を付与済み。
- ASG/インスタンスに識別タグ `Role=ninja-habits-api` + `Stage=<stage>` を付与済み（migration の対象選定用。ステージ混在を防ぐ）。
- ALB ターゲット/ヘルスチェックは現状（8080, `/health`）のまま流用。ただし `/health` は DB 接続必須（`SELECT 1`）な点に留意（§6）。

## 完了済み（CDK / スクリプト）
- **NetworkStack 分割**: 共有資源（VPC / SG / 成果物 S3 / 基盤 SSM）を集約、依存を Network→Database→Api に反転。`bin/app.ts`/`api-stack`/`database-stack` の参照配線も更新済み。
- **S3 成果物バケット**: NetworkStack に配置済み（api 起動前に存在）。
- **user-data 置換**: nginx 撤去 → Node 20 + S3 pull + env 組立 + systemd。インスタンスロール（SSM/S3/Secrets + `AmazonSSMManagedInstanceCore`）と `Role=ninja-habits-api` タグ付与済み。
- **SSM パラメータ所有**: §4 の通り。cognito-issuer/client-id=Auth、allowed-origin=Network、db/*=Database。artifact-key のみ手動/CI（`set-api-artifact.sh`）。
- **deploy script 分割**: `deploy:<stage>` は Database までで停止、Api は明示 `deploy:<stage>:api`。`set-api-artifact.sh` は `upload`/`promote` を分離（順序保護）。
- **release スクリプト一式**: `set-api-artifact.sh upload` → `run-migration.sh`（SSM Run Command）→ `set-api-artifact.sh promote` → `refresh-api.sh`（instance refresh）。手動でも CI でも同じ順で叩ける。
- **CI/CD**: `CicdStack`（OIDC provider + release ロール）と `.github/workflows/release-api.yml`（§7「実装」）。OIDC trust・scoped 権限・stage 直列化・artifact ビルド〜4 ステップを実装。
- **migration 実行経路**: SSM Run Command に確定（§5）。対象タグ `Role=ninja-habits-api` も確定・付与済み。
- `ninja-habits` 側のアプリ変更（2026-06-14）: `api:copy-migrations` 統合、`react`/`react-dom` を devDependencies へ、`engines.node` を `">=20 <21"` に固定。検証: `npm test`(171) / `npm run build` / `node dist-api/migrate.js` 確認済み。

## 完了記録

### dev 初回実走（2026-06-27）
- Network → Database → artifact upload/promote → Api → migration の §6 初回手順を手動で実走、全ステップ成功。
- HTTPS 対応（T-019 部分）: `ninja-habits.com` 取得、ACM 証明書（ap-northeast-1 / us-east-1）発行、ALB 443 リスナー + Route 53 A レコード（`api-dev.ninja-habits.com`）、CloudFront カスタムドメイン（`dev.ninja-habits.com`）を追加。
- Cognito callback / CORS を `https://dev.ninja-habits.com` に更新して疎通確認済み。
- dev 環境 URL: Web=`https://dev.ninja-habits.com`、API=`https://api-dev.ninja-habits.com`

### CI/CD 実走（2026-06-27）
- `release-api.yml` を `workflow_dispatch`（stage=dev, app_ref=main）で初回実行、全 10 ステップ成功（所要約 6 分）。
- OIDC 認証・artifact build/test/upload・migration・promote・instance refresh の一連フローを確認。
- secrets（`NINJA_HABITS_AWS_DEPLOY_ROLE_ARN` / `NINJA_HABITS_APP_REPO_TOKEN`）は設定済み。

### Release Web CI/CD 実走（2026-06-27）
- `release-web.yml` を `workflow_dispatch`（stage=dev, app_ref=main）で初回実行、全ステップ成功。
- OIDC 認証・SSM から cognito-client-id 取得・Vite ビルド・S3 sync・CloudFront invalidation の一連フローを確認。
- ログイン後 Failed to fetch は API スタック destroy 済みのため想定内。ページ表示・Cognito ログイン疎通は OK。

## prod 初回セットアップ手順

### 事前準備（1 回のみ）

#### GitHub Environment の作成（承認ゲート）

`release-api.yml` / `release-web.yml` は prod 向け job に `environment: production` を指定している。
GitHub UI でこの Environment を作成し、承認者を設定しないとワークフローが実行できない。

1. GitHub リポジトリ → **Settings → Environments → New environment**
2. 名前: `production`
3. **Required reviewers** に承認者（オーナー等）を追加
4. 保存

これ以降 prod への release は必ず承認待ちになる。

#### Secrets 確認

以下が `ninja-habits-infra` リポジトリの Secrets に設定済みであることを確認:

| シークレット名 | 内容 |
|--------------|------|
| `NINJA_HABITS_AWS_DEPLOY_ROLE_ARN` | CicdStack の ReleaseRole ARN |
| `NINJA_HABITS_APP_REPO_TOKEN` | ninja-habits リポジトリへの read アクセス |

### prod インフラ初回デプロイ順序

> **初回はインスタンスが artifact を pull して起動するため、ApiStack より前に promote が必要。**

```bash
# 1. 基盤スタック（課金なし）
npm run deploy:prod:hosting
npm run deploy:prod:auth
npm run deploy:prod:network

# 2. RDS（課金開始）
npm run deploy:prod:database

# 3. API artifact を事前 promote（ApiStack デプロイ前に必須）
cd ../ninja-habits
LABEL=$(date -u +%Y%m%d%H%M%S)
npm ci && npm test && npm run api:build && npm ci --omit=dev
tar -czf "/tmp/ninja-habits-api-${LABEL}.tgz" dist-api/ package.json node_modules/
cd ../ninja-habits-infra
npm run set-api-artifact:prod -- upload "/tmp/ninja-habits-api-${LABEL}.tgz" "$LABEL"
# 上記の出力から S3 キー（例: api/ninja-habits-api-20260628120000.tgz）を控える
npm run set-api-artifact:prod -- promote <s3-key>

# 4. ApiStack（課金開始）
npm run deploy:prod:api

# 5. インスタンスが SSM Online になるまで待つ（数分）

# 6. DB migration（初回）
npm run migrate-api:prod -- <s3-key>

# 7. WAF
npm run deploy:prod:waf
```

### prod 初回 Web デプロイ

インフラが揃った後、GitHub Actions で `release-web.yml` を手動実行（stage=prod）する。
prod Environment の承認者が承認するとビルド・S3 sync・CloudFront invalidation が実行される。

### 通常 prod リリース（2 回目以降）

GitHub Actions で `release-api.yml` を手動実行（stage=prod, app_ref=対象ブランチ/SHA）。
prod Environment 承認後に以下が自動実行される:

```
build / test → upload artifact → migrate → promote → instance refresh
```

### prod migration の露出回避

migration（`npm run migrate-api:prod`）は SSM Run Command で既存インスタンス上で実行される。
実行中に ALB からトラフィックを受け続けるが、migration は idempotent かつ後方互換 DDL のみとする設計のため、
通常は無停止で適用できる。破壊的 DDL が必要な場合は事前にメンテナンス告知を行う。

---

## 残アクション
- **Cognito ログイン画面のブランディング（T-031）**:
  - 目的: Cognito Hosted UI / Managed login を、既存アプリの `NINJA HABITS` デザインにできるだけ寄せる。
  - 既存デザイントークン: 背景 `#0F1117` / 外側 `#0a0c12`、カード `#1A1D27`、枠線 `#252836`、文字 `#F0F0F0`、muted `#8A8F9E`、CTA は白背景 + 黒文字、角丸 8〜12px。
  - 実装候補: `AuthStack` の `userPool.addDomain(...)` に `managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN` を設定し、`AWS::Cognito::ManagedLoginBranding`（CDK では `cognito.CfnManagedLoginBranding`）で Web app client 向けの branding を作成する。
  - ロゴ/背景: まずはシンプルなロゴまたはブランド名ベースで開始。画像アセットが必要な場合は、秘密情報を含まない静的アセットとして管理方法を決める。
  - 制約: Cognito 側の文言やHTML構造は自由に変更できない。完全一致が必要になった場合は、Hosted UI をやめて `ninja-habits` 側に自前ログイン画面を実装し、Cognito API / Amplify Auth で認証する案を検討する。
- in-VPC CodeBuild は現状 SSM Run Command で十分なため、規模次第で将来判断。
