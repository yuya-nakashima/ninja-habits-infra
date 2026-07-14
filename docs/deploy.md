# デプロイ方式（サーバーレス構成 / 2026-07-03 改訂）

`ninja-habits` を固定費ほぼゼロで運用するためのデプロイ方式メモ。
2026-07-03 のサーバーレス移行決定（ワークスペース `../../docs/decisions.md` 2026-07-03）により、
**API=Google Cloud Run / DB=Neon / フロント=S3+CloudFront（据え置き）/ 認証=Cognito（据え置き）** に変更した。

> **旧構成の撤去**: 以前の `ALB + Auto Scaling Group + EC2 + RDS + NAT + WAF + CloudWatch Alarms` 前提の
> デプロイ方式（artifact S3 pull / SSM Run Command migration / instance refresh）は撤去した。
> 対応する CDK スタック（`network` / `database` / `api` / `waf` / `alarm`）と
> スクリプト（`set-api-artifact.sh` / `run-migration.sh` / `refresh-api.sh`）、
> 旧 workflow（`release-api.yml`）は削除済み。旧方式の詳細が要る場合は git 履歴を参照。

## 現在のスタック構成（CDK が管理するもの）

このリポジトリの CDK で管理するのは、AWS 上でほぼ無料の 3 スタックのみ:

- **CicdStack（`NinjaHabits-Cicd`, account 単位）**: GitHub OIDC provider + Web release ロール
  `ninja-habits-ci-release`（S3 sync / CloudFront invalidation / Cognito client-id 取得に限定）。
- **HostingStack（`NinjaHabits-<stage>-Hosting`）**: S3 + CloudFront + セキュリティヘッダー + アクセスログ。
- **AuthStack（`NinjaHabits-<stage>-Auth`）**: Cognito User Pool + Web app client + Hosted UI + Managed Login branding。

API と DB は AWS 外（Cloud Run / Neon）で動くため、このリポジトリの CDK には含めない。

## 構成図（概略）

```
Browser (SPA)
  ├─ 静的配信:  CloudFront + S3           （AWS / HostingStack）
  ├─ 認証:      Cognito Hosted UI (PKCE)  （AWS / AuthStack）
  └─ API 呼出:  https://...run.app        （GCP / Cloud Run） ── TLS ──> Neon Postgres
```

- API は公開エンドポイント（`--allow-unauthenticated`）。アクセス制御はアプリ層で行う
  （**public endpoint + Cognito JWT 検証 + CORS 制限**）。GCP IAM 認証では閉じない。
- Cloud Run は `min-instances=0`（アイドル $0）、`max-instances=1〜2`（コスト暴走ガード）。
- DB は Neon（外部・TLS）。Lambda/VPC/NAT は使わない。`api/db.ts` が localhost 以外を自動で TLS 検証。

---

## API（Cloud Run）デプロイ

app リポジトリの workflow `ninja-habits/.github/workflows/deploy-api.yml` が
**build image → push(Artifact Registry) → migrate(Neon) → `gcloud run deploy`** を実行する。
GCP 認証は **Workload Identity Federation（OIDC）**。静的キーは置かない。

### GCP 事前準備（手動・1 回）

1. **GCP プロジェクト**を用意（region は `asia-northeast1` 推奨）。
2. **Artifact Registry** リポジトリを作成（Docker 形式）。
3. **Cloud Run サービス**を dev / prod で作成（初回は workflow の `gcloud run deploy` が作成してもよい）。
4. **Secret Manager**: Neon の接続文字列を stage ごとに保存（例 `ninja-habits-dev-database-url`）。
   値は Neon の **pooled** 接続文字列（`...-pooler...neon.tech/<db>?sslmode=require`）。
5. **サービスアカウント（最小権限）**:
   - デプロイ用 SA: `roles/artifactregistry.writer`、`roles/run.admin`、`roles/iam.serviceAccountUser`、
     および対象 DATABASE_URL secret への `roles/secretmanager.secretAccessor`（migration ステップで参照）。
   - ランタイム SA（Cloud Run 実行時）: 対象 DATABASE_URL secret への `roles/secretmanager.secretAccessor` のみ。
6. **Workload Identity Federation**: Workload Identity Pool + Provider（`token.actions.githubusercontent.com`）を作成し、
   `repo:yuya-nakashima/ninja-habits:*` に限定。

### GitHub 設定（app リポジトリ `ninja-habits`）

- Repository secrets: `GCP_WORKLOAD_IDENTITY_PROVIDER`、`GCP_DEPLOY_SERVICE_ACCOUNT`
- Environments（`dev` / `prod`）ごとの variables:
  `GCP_PROJECT_ID` / `GCP_REGION` / `AR_REPOSITORY` / `CLOUD_RUN_SERVICE` / `RUNTIME_SERVICE_ACCOUNT` /
  `DATABASE_URL_SECRET` / `API_ALLOWED_ORIGIN` / `COGNITO_ISSUER` / `COGNITO_CLIENT_ID` / `MAX_INSTANCES`
- prod Environment に承認者（Required reviewers）を設定して承認ゲートにする。

### リリース順序と migration の安全性

- 順序は **migrate（後方互換 DDL のみ）→ deploy**。deploy 失敗時は DB だけ先行するが、
  migration が後方互換なら旧リビジョンが新スキーマ上で動作継続できる。
- migration は **forward-only**（`schema_migrations` で冪等、down は持たない）。破壊的変更は
  **expand/contract**（列追加→デプロイ→後日旧列削除）で複数リリースに分割する。
- ロールバックは Cloud Run のリビジョン戻しで対応。

### API 必要 env（Cloud Run）

`PORT`（Cloud Run 注入）/ `DATABASE_URL`（Secret Manager）/ `API_ALLOWED_ORIGIN`（CloudFront Web オリジン）/
`COGNITO_ISSUER` / `COGNITO_CLIENT_ID`。`API_DEV_AUTH` は設定しない（起動時 `assertSafeConfig` が issuer 併用を拒否）。

### ローカル確認

```sh
# API（ローカル Postgres or Neon dev branch）
docker compose -f api/docker-compose.yml up -d
DATABASE_URL=<local-or-neon> node dist-api/migrate.js
API_DEV_AUTH=true npm run api:dev
curl http://127.0.0.1:8080/health        # DB 非依存の liveness（Neon を起こさない）
```

---

## フロント（S3 + CloudFront）デプロイ

従来どおり AWS。workflow `.github/workflows/release-web.yml` が
**Vite build → S3 sync → CloudFront invalidation** を実行（AWS OIDC + CicdStack の Web release ロール）。
`VITE_API_BASE_URL` に Cloud Run の URL（または独自 API ドメイン）を指定する。
Cognito の callback/logout URL は Web ドメイン（`dev.ninja-habits.com` / `ninja-habits.com`）のままで変更不要。

### 初回インフラデプロイ（AWS 側・課金ほぼ無し）

```sh
npm run deploy:cicd            # account 単位（1 回）
npm run deploy:dev             # NinjaHabits-dev-Hosting + NinjaHabits-dev-Auth
# prod は npm run deploy:prod
```

---

## コスト / 残る固定費

- 常時稼働課金（NAT / RDS / ALB / EC2 / WAF）は撤去。
- 残るのは小額のみ: Cloud Run（従量・アイドル$0）/ Artifact Registry / GCP Secret Manager /
  Neon（free plan, scale-to-zero）/ Cognito（無料枠）/ S3+CloudFront（低トラフィック）/
  Route53 Hosted Zone（~$0.5/月）/ ACM（無料）。
- 目安: **月 $1 未満〜数ドル + ドメイン年額**。これを明確に超える請求が見えたら異常として調査する。

### コスト監視・金額操作のルール（2026-07-12 追記）

2026-07 の実例からの教訓:

- **通貨事故**: GCP 課金アカウント「Firebase のお支払い」（`01A8AB-991CE4-520308`）の通貨は **SGD**（JPY ではない）。
  予算を `1500JPY` 指定で作成したところ SGD 1,500（≈¥17万）の予算になった。発見後 **SGD 15（≈¥1,700）に修正済み**。
- **発見遅れ**: 2026-06 に run-rate ~$460/月へ到達したが、月初の請求額には数日分しか反映されず実態把握が遅れた
  （請求額でなく **run-rate（日割り×30）** で見る）。

ルール:

1. 金額を指定する操作（予算・アラート・課金リソース作成）の前に、**課金アカウントの通貨・表示単位を確認**する。
   GCP は `gcloud billing accounts list`、AWS は Cost Explorer / Budgets の作成値を読み戻して確認する。
   作成後は必ず実値を読み戻して**金額・通貨・対象スコープ**を検証する。
2. 常時課金リソース（NAT / RDS / ALB / EC2 / min-instances>0 等）を作る変更は、**月額見積りを添えて**判断する。
3. アラート現況:
   - GCP: 予算 `ninja-habits`（**SGD 15/月**、50/90/100% でメール通知、対象 project 限定）
   - AWS: Budgets 未設定。作成する場合は、Cost Explorer で当月実績・run-rate・対象スコープ
     （アカウント全体 / Ninja 関連のみ。アカウント全体には非 Ninja の EC2 3台も含まれる点に注意）を
     確認してから閾値を決め、作成後に BudgetLimit と通知先を読み戻す。通知のみの Budgets は無料（Budget Actions は別料金）
   - Neon: free plan の usage 上限で自動停止（超過課金なし）

## Neon の dev/prod 分離方針

- まず **branch 分離**（安価・簡便、無料枠内）で開始。
- 公開（実ユーザー投入 / 課金開始）前に **2 プロジェクト分離**へ再検討（事故耐性を優先）。

## 残アクション

- 独自 API ドメイン（`api.ninja-habits.com`）を張るかは任意（当面 `run.app` URL で可）。
- AWS 残存リソースの最終確認 → **2026-07-05 実施済み（下記チェックリスト参照）**。
- 保持中リソースの期限判断 → **2026-07-10 削除実施済み**（prod artifact S3 / prod RDS 最終スナップショット。
  削除条件充足＋オーナー明示承認のうえ実行。下記チェックリスト参照）。

## 完了記録: GCP / Neon プロビジョニングと初回デプロイ（2026-07-05〜07-08）

- GCP project `ninja-habits`（676967997935, asia-northeast1）: Artifact Registry / Secret Manager（dev/prod DATABASE_URL）/
  deploy SA `gh-deployer` + runtime SA `nh-api-dev`/`nh-api-prod`（最小権限）/ WIF（`repo:yuya-nakashima/ninja-habits` 限定）/
  予算アラート（SGD 15/月 ≈ ¥1,700, 50/90/100%）。
- Neon project `ninja-habits`（aws-ap-southeast-1, pg18）: branch `production`（default）/ `dev`。migration 001/002 適用済み。
- `deploy-api.yml` 初回実走: dev / prod（prod は Environment 承認ゲート経由）とも成功。
  - dev API: `https://ninja-habits-api-dev-3q2ccf6onq-an.a.run.app`
  - prod API: `https://ninja-habits-api-prod-3q2ccf6onq-an.a.run.app`
- Web 切替: `release-web.yml` の `VITE_API_BASE_URL` を dev/prod とも上記 Cloud Run URL に変更し、Release Web 実走済み。
- 外形確認（2026-07-08 再検証）: 両 stage の `/health` 200・未認証 401・CORS は各 Web オリジンのみ許可・
  配信 JS が Cloud Run URL を参照。dev は実ログインで `/v1/today` 200（runtime→Neon 実経路）を確認。

---

## AWS クリーンアップ チェックリスト（2026-07-05 棚卸し / account 720623131603 ap-northeast-1）

サーバーレス移行後の Ninja 残存リソースを棚卸し。課金要素はほぼ一掃済み（残実費 月 ~$2）。

### 削除済み（2026-07-05）
- Secrets Manager `DatabaseAdminSecretA904CE67-yLG9IOxYsMCi`（旧 RDS admin, 孤立）: **7日リカバリ猶予つき削除。2026-07-12 に完全削除**（それまでは `restore-secret` で復旧可）。
- CloudWatch Logs `aws-waf-logs-ninja-habits-prod-api`（WAF 削除済みで孤立）: 削除。
- SSM `/ninja-habits/dev/api/artifact-key`・`/ninja-habits/prod/api/artifact-key`（旧 S3 pull デプロイ用, Cloud Run 移行で不要）: 削除。

### 期限付き保持 → 2026-07-10 削除実施済み
- **RDS 手動スナップショット** `ninjahabits-prod-database-snapshot-…dyji3ohykhts`（20GB, ~$1.9/月）: **2026-07-10 削除**。
  - 削除条件（Neon 本番移行＋主要フロー確認、ロールバックに RDS 不使用）をオーナー確認のうえ実行。
- **S3 `ninja-habits-api-artifacts-prod-720623131603`**: **2026-07-10 削除**。
  - 削除条件（初回 Cloud Run デプロイ成功、AWS API 再デプロイ予定なし）をオーナー確認のうえ実行。
  - バージョニング有効だったため全バージョン＋削除マーカーを削除してからバケット削除（`delete-objects` → `delete-bucket`）。

### 保持（現役・触らない）
- SSM `/ninja-habits/{dev,prod}/api/cognito-client-id`・`…/cognito-issuer`（release-web.yml ＋ deploy-api の GitHub 変数取得元。issuer: dev `ap-northeast-1_Zei8pcJQL` / prod `ap-northeast-1_l4Ywp8eVj`）。
- S3 `ninja-habits-{dev,prod}-web` / `…-{dev,prod}-logs`（Hosting 現役）、`cdk-hnb659fds-assets-…`（CDK bootstrap）。

### 対象外（非 Ninja・触らない）
- EC2 `soudan-hub` / `moyai-lab` / `body-data-lab`（稼働中の別プロジェクト）、EIP 35.77.154.180（soudan-hub）/ 35.76.200.8（body-data-lab, 関連付け済み＝無料）。

### 撤去確認済み（Ninja 残存なし）
- WAF Web ACL（REGIONAL/CLOUDFRONT 0）、NAT Gateway 0、ALB 0、Target Group 0、Ninja 由来 EC2 0。

---

## 完了記録: Cognito ログイン画面のブランディング（T-031 / 2026-07-03）

- 目的: Cognito Hosted UI / Managed login を、既存アプリの `NINJA HABITS` デザインに寄せる。
- 実装（`lib/auth-stack.ts`）:
  - `userPool.addDomain(...)` に `managedLoginVersion: NEWER_MANAGED_LOGIN` を設定。
  - `cognito.CfnManagedLoginBranding` で Web app client 向け branding を作成。
    ダークテーマの色・コンポーネント設定（背景 `#0F1117` / フォーム `#181a22` / 文字 `#F0F0F0` / muted `#8A8F9E` / CTA 白背景+黒文字 / 角丸 8px 等）を `NINJA_HABITS_MANAGED_LOGIN_BRANDING` 定数に定義。
  - **ブランドロゴ**: `components.form.logo.enabled: true` ＋ `assets`（`category: FORM_LOGO`, `colorMode: DARK`, `extension: SVG`）で表示。
- **ロゴアセットの管理**: `ninja-habits-infra/assets/login-logo.svg`（手裏剣マーク＋「NINJA HABITS」の自己完結 SVG）を infra 内に保持し、
  synth 時に `fs.readFileSync` → base64 化して埋め込む。design-system への synth 時参照は避ける（クロスリポ依存回避）。秘密情報は含まない静的アセット。
- **Cognito SVG サニタイザの制約**: FORM_LOGO の SVG は許可要素/属性のみ。`role` / `aria-label` 等は
  `element [svg#role|aria-label] is not allowed` で拒否されるため属性を最小化した。`<text>`/`<tspan>` はそのまま許可された。
  文字が閲覧環境で崩れる場合は文字を path アウトライン化する（今回は Arial/Helvetica/sans-serif スタックで問題なく描画）。
- 実機確認: dev（`ninja-habits-dev.auth...`）/ prod（`ninja-habits-prod.auth...`）とも Hosted UI にロゴ表示・色整合・console エラー無しを確認。
- **既知の残差**: 「Forgot your password?」「Create an account」等の Cognito 標準リンク／入力フォーカスリングは既定の青アクセントのままで、
  ブランドのモノクロ配色から外れる。`componentClasses.link` では上書きされない別トークン起因。完全一致が要る場合は
  Hosted UI をやめて `ninja-habits` 側に自前ログイン画面を実装し Cognito API / Amplify Auth で認証する案を検討。
