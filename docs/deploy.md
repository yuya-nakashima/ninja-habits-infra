# API デプロイ方式（T-020 設計）

`ninja-habits` の API（Node ESM, `dist-api/server.js`）を `ninja-habits-infra` の
ALB + ASG(EC2) 構成へ配布・更新する方式の設計メモ。コードは未実装で、これは方針合意のための設計。

## 現状

- api-stack: VPC(public/private) + ALB + ASG(LaunchTemplate, Amazon Linux 2023)。
  **user-data は nginx で静的 JSON を返すプレースホルダ**で、実 API は未搭載。
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
- `DATABASE_URL` の組み立て（出所を固定。P2）:
  - **host**: SSM Parameter `/ninja-habits/<stage>/db/endpoint`（database-stack の `DatabaseEndpointAddress` 出力を投入）
  - **port**: `5432` 固定（必要なら SSM 化）
  - **dbname**: SSM Parameter `/ninja-habits/<stage>/db/name`（config の `databaseName`）
  - **user / password**: Secrets Manager（database-stack の `DatabaseSecretArn`）の JSON フィールド `username` / `password`
  - **SSL**: RDS なので `sslmode=require` を付与（`pg` の接続文字列に明記）
  - 形: `postgresql://<user>:<pass>@<host>:5432/<dbname>?sslmode=require`
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
  - 対象インスタンス選定: ASG タグ（例 `Role=ninja-habits-api`）でフィルタし先頭 1 台。
  - 代替: VPC 内に専用の一時 migration タスク（CodeBuild in-VPC 等）を置く案もあるが、追加構成が要るため後回し。
- runner は `schema_migrations` で冪等。**forward-only**（down は持たない）。破壊的変更は expand/contract で段階適用する。
- 順序: 新 artifact を S3 へ upload → その artifact で migrate（後方互換な変更）→ artifact-key 更新 → instance refresh。

### 6. 初回デプロイ / ブートストラップ（first deploy）

**前提となる stack 構成の変更**（§ 後述「スタック構成」）。現行は `ApiStack` が VPC/SG を所有し
`DatabaseStack` がそれを参照（= database が api に依存、デプロイ順は api→database）。
この向きだと「DB を先に作ってから api を起動」ができず、しかも `/health` は `SELECT 1` を実行する＝
**DB が無いと api インスタンスは health を通らず ASG が回り続ける**。よって順序を実装可能にするため、
共有資源（VPC / SG / 成果物 S3 / 基盤 SSM）を **NetworkStack** に切り出し、database / api の両方がそれを参照する形に変更する（依存の根を NetworkStack にする）。

初回手順（NetworkStack 導入後）:

1. **NetworkStack をデプロイ**（VPC・SG・成果物 S3 バケット・基盤 SSM パラメータ枠を作成）
2. **新 artifact を S3 アップロード**し、**SSM `artifact-key` を設定**（user-data が起動時に解決できる状態に）
3. **DatabaseStack をデプロイ**（RDS + admin secret 作成）。`endpoint` / `dbname` を SSM へ投入、**secret ARN** を api が参照できるよう SSM か cross-stack export で渡す（secret は database-stack 生成のため、api より先に database を deploy する必要がある＝この順序で ARN が確定する。P2）
4. **ApiStack をデプロイ**（ALB + ASG）。user-data は artifact を pull → env（DB endpoint/secret 等）を組み立て → systemd 起動。DB は既に存在するので接続可。
   - DB は未マイグレートだが `/health` の `SELECT 1` は通る（接続成功、テーブル不問）ため ELB ヘルスチェックは PASS し InService になる。`/v1/*` は migration 後に 200。
5. 対象インスタンスが **SSM online** になるのを待つ
6. **新 artifact で migration を実行**（§5 の SSM Run Command）
7. **ALB 経由で API 動作確認**（`/v1/me` 等が 200）
- 以降は §6.1 の通常リリースに移行する。

> 軽量代替（NetworkStack を切らない場合）: api-stack の ASG を初回 `desiredCapacity=0` でデプロイ→database-stack→SSM 投入→ASG をスケールアップ、で順序を作る手もある。ただし依存方向（database→api）は現状のままで、secret/endpoint の受け渡しは別途必要。NetworkStack 分割の方が後続も素直なため第一候補とする。

> 露出の留意: 初回はごく短時間「未マイグレート API が公開」されうる。dev では許容。prod 公開時は (a) 先に最小1台で migration→スケールアウト、(b) ALB リスナーを後段で有効化、で回避（T-019 と合わせて検討）。

### 6.1 リリース/更新フロー（instance refresh）
1. CI: build → test → package → **新 artifact を S3 アップロード**（バージョン付きキー）
2. **新 artifact で migration 実行**（SSM Run Command が S3 から新 artifact を取得して実行。§5。後方互換前提）
3. SSM `artifact-key` を新バージョンへ更新
4. ASG の **instance refresh** をトリガ（新インスタンスが新成果物を pull）。ELB ヘルスチェックで段階入替（`deregistrationDelay=30s` 設定済み）。
5. ロールバック: `artifact-key` を前バージョンへ戻して再 refresh（migration は forward-only のため、スキーマは後方互換で運用）。

### 7. CI
- GitHub Actions（リポジトリは GitHub）。**OIDC で AWS デプロイ用ロールを assume**（静的キーを置かない）。
- デプロイロール権限: S3 put、SSM `PutParameter`、ASG `StartInstanceRefresh`、migration 用の `ssm:SendCommand` + `ssm:GetCommandInvocation`（対象 API インスタンス）。

## 代替案（今回は不採用、将来検討）
- **AMI 焼き込み（Packer）**: 起動が速く不変。リリース毎の AMI ビルドと LaunchTemplate 更新が要る。トラフィック増/起動頻度が上がったら移行。
- **コンテナ（ECR + ECS/Fargate）**: スケール・運用は楽だが、現行 EC2/ASG からの構成変更が大きい。Paid 規模化で再検討。

## スタック構成の変更（T-030 実装の前提・実装は別タスク）

現行の依存方向（database → api、api が VPC/SG 所有）を反転し、共有資源を **NetworkStack** に集約する。

- **NetworkStack（新規）**: VPC、`apiInstanceSecurityGroup`、`albSecurityGroup`（および SG 間 ingress）、
  成果物 S3 バケット、基盤 SSM パラメータ（`artifact-key` 等）。依存の根。
- **DatabaseStack**: NetworkStack の VPC/SG を参照。RDS + admin secret を生成し、
  `endpoint`/`dbname` を SSM へ、secret ARN を SSM か export で公開（api が起動時に参照）。
- **ApiStack**: NetworkStack の VPC/SG/バケット/SSM と DatabaseStack の DB 参照を消費。ALB + ASG のみ。
- デプロイ順: **Network → Database → Api**（`bin/app.ts` の参照配線もこの向きに修正）。

### api-stack に必要な変更
- user-data: nginx 撤去 → nodejs 導入 + S3 pull + env 組立（DB endpoint/secret/SSM）+ systemd 起動へ置換。
- インスタンスロール追加: `s3:GetObject`（成果物）、`ssm:GetParameter`、`secretsmanager:GetSecretValue`、
  および **SSM Run Command 用に `AmazonSSMManagedInstanceCore`**（SSM Agent は AL2023 にプリインストール、egress は private+NAT で到達可）。
- ASG/インスタンスに識別タグ（例 `Role=ninja-habits-api`）を付与（migration の対象選定用）。
- ALB ターゲット/ヘルスチェックは現状（8080, `/health`）のまま流用可。ただし `/health` は DB 接続必須（`SELECT 1`）な点に留意（§6）。

## 未決事項 / 次アクション
- スタック構成: 共有資源を **NetworkStack** に切り出し、依存を Network→Database→Api に反転（上記「スタック構成の変更」）。`bin/app.ts`/`api-stack`/`database-stack` の参照配線変更が T-030 の最初の作業。
- S3 成果物バケットは **NetworkStack** に配置（api 起動前に存在させるため）。
- migration 実行経路: **SSM Run Command に確定**（§5）。残課題は対象インスタンス選定タグの命名と、in-VPC CodeBuild 案を将来採るかの判断のみ。
- `ninja-habits` 側のアプリ変更（**完了** 2026-06-14）:
  - `api:build` に `api:copy-migrations`（`api/migrations/*.sql` → `dist-api/migrations/`）を統合。`build` も `api:build` 経由に統一。
  - `react`/`react-dom` を devDependencies へ移動（dependencies は `pg` のみ）。
  - `engines.node` を `">=20 <21"` に固定。
  - 検証: `npm test`(171) / `npm run build` / `node dist-api/migrate.js`(SQL を読み skip) 確認済み。
- database-stack 出力（endpoint/dbname）→ SSM Parameter への投入方法（stack 間 import か手動）。
- T-019（HTTPS/ドメイン/WAF）と合わせて 443 リスナー・証明書を有効化。
