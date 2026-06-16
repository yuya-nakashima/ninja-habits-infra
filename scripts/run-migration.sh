#!/usr/bin/env bash
# Run DB migration on RDS using a SPECIFIC API artifact, via SSM Run Command
# (deploy.md §5). RDS is in a private subnet, so migration runs ON an API
# instance: the instance downloads the given artifact to a temp dir, builds
# DATABASE_URL from SSM + Secrets Manager, and runs that artifact's migrate.js.
#
# This is forward-only and idempotent (schema_migrations). Run it with the NEW
# key BEFORE promoting artifact-key on a release (deploy.md §6.1 step 2).
#
# Usage:
#   STAGE=<stage> bash scripts/run-migration.sh <s3-key>
#     <s3-key> is the key printed by 'set-api-artifact.sh upload' (e.g. api/ninja-habits-api-<ver>.tgz).
#
# Prerequisites: aws CLI + jq configured locally; NinjaHabits-<stage>-Network and
# at least one SSM-online API instance (tag Role=ninja-habits-api) running.

set -euo pipefail

STAGE="${STAGE:-dev}"
AWS_REGION="${AWS_REGION:-ap-northeast-1}"
NETWORK_STACK="NinjaHabits-${STAGE}-Network"
ROLE_TAG="ninja-habits-api"

# base64 each value so it can be embedded in the remote shell with zero injection
# surface (artifact keys carry an unsanitized version-label). base64 output is
# [A-Za-z0-9+/=] only; the remote decodes it back.
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

KEY="${1:-}"
if [ -z "$KEY" ]; then
  echo "Error: missing <s3-key>. Usage: STAGE=<stage> bash scripts/run-migration.sh <s3-key>" >&2
  exit 1
fi

BUCKET="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "$NETWORK_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiArtifactBucketName'].OutputValue" \
  --output text)"
if [ -z "$BUCKET" ] || [ "$BUCKET" = "None" ]; then
  echo "Error: could not resolve ApiArtifactBucketName from $NETWORK_STACK." >&2
  exit 1
fi

# Pick a running, SSM-online API instance for THIS stage (deploy.md §5).
# Intersect: running instances tagged Role+Stage  ∩  SSM PingStatus=Online,
# so we don't fail just because the first running one isn't registered yet
# (e.g. mid instance-refresh), and don't pick another stage's instance.
RUNNING_IDS="$(aws ec2 describe-instances \
  --region "$AWS_REGION" \
  --filters "Name=tag:Role,Values=${ROLE_TAG}" "Name=tag:Stage,Values=${STAGE}" "Name=instance-state-name,Values=running" \
  --query 'Reservations[].Instances[].InstanceId' \
  --output text | tr '\t' '\n' | sed '/^$/d')"
if [ -z "$RUNNING_IDS" ]; then
  echo "Error: no running instance with tags Role=${ROLE_TAG}, Stage=${STAGE}. Deploy the Api stack first." >&2
  exit 1
fi

ONLINE_IDS="$(aws ssm describe-instance-information \
  --region "$AWS_REGION" \
  --filters "Key=PingStatus,Values=Online" \
  --query 'InstanceInformationList[].InstanceId' \
  --output text | tr '\t' '\n' | sed '/^$/d')"

INSTANCE_ID=""
for id in $RUNNING_IDS; do
  if printf '%s\n' "$ONLINE_IDS" | grep -qx "$id"; then
    INSTANCE_ID="$id"
    break
  fi
done
if [ -z "$INSTANCE_ID" ]; then
  echo "Error: no SSM-online instance among running ${ROLE_TAG}/${STAGE} candidates. Wait for SSM registration." >&2
  exit 1
fi

echo "Target instance: $INSTANCE_ID"
echo "Artifact:        s3://$BUCKET/$KEY"

# Remote script. The header decodes base64-injected values (no shell-special
# chars, so no injection even if the artifact key contains quotes); the quoted
# heredoc body runs on the instance and builds DATABASE_URL the same way
# user-data does (URL-encoded user/password, sslmode=require).
REMOTE_HEADER="$(printf 'STAGE="$(printf %%s %s|base64 -d)"\nREGION="$(printf %%s %s|base64 -d)"\nARTIFACT_BUCKET="$(printf %%s %s|base64 -d)"\nARTIFACT_KEY="$(printf %%s %s|base64 -d)"\n' \
  "$(b64 "$STAGE")" "$(b64 "$AWS_REGION")" "$(b64 "$BUCKET")" "$(b64 "$KEY")")"
REMOTE_BODY="$(cat <<'RS'
set -euo pipefail
SSM_DB="/ninja-habits/$STAGE/db"
gp() { aws ssm get-parameter --region "$REGION" --name "$1" --query 'Parameter.Value' --output text; }
DB_ENDPOINT="$(gp "$SSM_DB/endpoint")"
DB_NAME="$(gp "$SSM_DB/name")"
DB_SECRET_ARN="$(gp "$SSM_DB/secret-arn")"
DB_SECRET_JSON="$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$DB_SECRET_ARN" --query 'SecretString' --output text)"
DB_USER="$(printf '%s' "$DB_SECRET_JSON" | jq -r '.username')"
DB_PASS="$(printf '%s' "$DB_SECRET_JSON" | jq -r '.password')"
enc() { python3 -c 'import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
export DATABASE_URL="postgresql://$(enc "$DB_USER"):$(enc "$DB_PASS")@$DB_ENDPOINT:5432/$DB_NAME?sslmode=require"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
aws s3 cp --region "$REGION" "s3://$ARTIFACT_BUCKET/$ARTIFACT_KEY" "$TMP/app.tgz"
tar -xzf "$TMP/app.tgz" -C "$TMP"
node "$TMP/dist-api/migrate.js"
RS
)"
REMOTE_SCRIPT="${REMOTE_HEADER}
${REMOTE_BODY}"

CMD_ID="$(aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" \
  --comment "ninja-habits ${STAGE} migration ${KEY}" \
  --parameters "$(jq -n --arg s "$REMOTE_SCRIPT" '{commands: [$s]}')" \
  --query 'Command.CommandId' \
  --output text)"
echo "SSM command: $CMD_ID (waiting...)"

# 'wait' returns non-zero on failure; capture output either way.
set +e
aws ssm wait command-executed --region "$AWS_REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID"
set -e

STATUS="$(aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query 'Status' --output text)"
echo "--- migration stdout ---"
aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query 'StandardOutputContent' --output text

if [ "$STATUS" != "Success" ]; then
  echo "--- migration stderr ---" >&2
  aws ssm get-command-invocation --region "$AWS_REGION" --command-id "$CMD_ID" --instance-id "$INSTANCE_ID" --query 'StandardErrorContent' --output text >&2
  echo "Migration FAILED (status=$STATUS). Do NOT promote artifact-key." >&2
  exit 1
fi

echo "Migration succeeded. Next: promote artifact-key, then instance refresh (deploy.md §6.1)."
