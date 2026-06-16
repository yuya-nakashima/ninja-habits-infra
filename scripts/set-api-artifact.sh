#!/usr/bin/env bash
# Manage API deployment artifacts. Two subcommands keep upload and promote
# SEPARATE so the release ordering in deploy.md (§6.1) is preserved:
#   upload -> migrate with the NEW artifact -> promote artifact-key -> instance refresh.
# Promoting before migration risks an ASG replacement booting new code against an
# unmigrated DB, so this script never does both in one step.
#
# Build the artifact in ninja-habits first (deploy.md §1):
#   npm ci && npm test && npm run api:build && npm ci --omit=dev
#   tar -czf ninja-habits-api-<version>.tgz dist-api package.json node_modules
#
# Usage:
#   STAGE=<stage> bash scripts/set-api-artifact.sh upload  <path-to-tgz> [version-label]
#       Uploads the tgz to the Network stack's bucket and prints the S3 key.
#       Does NOT change /api/artifact-key.
#   STAGE=<stage> bash scripts/set-api-artifact.sh promote <s3-key>
#       Points /ninja-habits/<stage>/api/artifact-key at <s3-key>.
#
# First deploy (no instances yet — migration runs after the ASG exists):
#   1. upload  2. promote  3. npm run deploy:<stage>:api  4. run migration (SSM Run Command)
# Release (instances already running):
#   1. upload  2. run migration with the NEW key (SSM Run Command)  3. promote  4. instance refresh
#
# Prerequisites: aws CLI configured, NinjaHabits-<stage>-Network already deployed.

set -euo pipefail

STAGE="${STAGE:-dev}"
AWS_REGION="${AWS_REGION:-ap-northeast-1}"
NETWORK_STACK="NinjaHabits-${STAGE}-Network"
PARAM_NAME="/ninja-habits/${STAGE}/api/artifact-key"

usage() {
  echo "Usage:" >&2
  echo "  STAGE=<stage> bash scripts/set-api-artifact.sh upload  <path-to-tgz> [version-label]" >&2
  echo "  STAGE=<stage> bash scripts/set-api-artifact.sh promote <s3-key>" >&2
  exit 1
}

resolve_bucket() {
  local bucket
  bucket="$(aws cloudformation describe-stacks \
    --region "$AWS_REGION" \
    --stack-name "$NETWORK_STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='ApiArtifactBucketName'].OutputValue" \
    --output text)"
  if [ -z "$bucket" ] || [ "$bucket" = "None" ]; then
    echo "Error: could not resolve ApiArtifactBucketName from $NETWORK_STACK. Deploy the Network stack first." >&2
    exit 1
  fi
  printf '%s' "$bucket"
}

cmd_upload() {
  local tgz_path="${1:-}"
  local version="${2:-$(date -u +%Y%m%d%H%M%S)}"

  if [ -z "$tgz_path" ] || [ ! -f "$tgz_path" ]; then
    echo "Error: artifact tgz not found: '${tgz_path}'" >&2
    usage
  fi

  local bucket key
  bucket="$(resolve_bucket)"
  key="api/ninja-habits-api-${version}.tgz"

  echo "Uploading $tgz_path -> s3://$bucket/$key"
  aws s3 cp --region "$AWS_REGION" "$tgz_path" "s3://$bucket/$key"

  echo
  echo "Uploaded. S3 key: $key"
  echo "Next:"
  echo "  - First deploy: promote '$key', then 'npm run deploy:${STAGE}:api', then run migration."
  echo "  - Release:      run migration with this key (SSM Run Command), then promote '$key', then instance refresh."
}

cmd_promote() {
  local key="${1:-}"
  if [ -z "$key" ]; then
    echo "Error: missing <s3-key> to promote." >&2
    usage
  fi

  echo "Setting SSM $PARAM_NAME = $key"
  aws ssm put-parameter \
    --region "$AWS_REGION" \
    --name "$PARAM_NAME" \
    --type String \
    --value "$key" \
    --overwrite

  echo
  echo "Promoted. New ASG instances will boot this artifact."
  echo "  - First deploy: now 'npm run deploy:${STAGE}:api', then run migration once instances are SSM-online."
  echo "  - Release:      trigger an ASG instance refresh (migration must already be applied)."
}

case "${1:-}" in
  upload)  shift; cmd_upload  "$@" ;;
  promote) shift; cmd_promote "$@" ;;
  *)       usage ;;
esac
