#!/usr/bin/env bash
# Sync pre-built SPA to S3 and invalidate CloudFront.
# Requires: ninja-habits/dist to exist (run 'npm run build' there first).
#
# Usage:
#   STAGE=dev  bash scripts/sync-app.sh
#   STAGE=prod bash scripts/sync-app.sh
#
# Prerequisites: aws CLI configured, cdk deploy already run for the stage.

set -euo pipefail

STAGE="${STAGE:-dev}"
AWS_REGION="${AWS_REGION:-ap-northeast-1}"
STACK_NAME="NinjaHabits-${STAGE}-Hosting"
DIST_DIR="$(cd "$(dirname "$0")/../../ninja-habits" && pwd)/dist"

if [ ! -d "$DIST_DIR" ]; then
  echo "Error: build output not found at $DIST_DIR" >&2
  echo "Run 'npm run build' inside ninja-habits first." >&2
  exit 1
fi

echo "Stage: $STAGE  Region: $AWS_REGION  Stack: $STACK_NAME"

BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" \
  --output text)

DISTRIBUTION_ID=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" \
  --output text)

DISTRIBUTION_URL=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionUrl'].OutputValue" \
  --output text)

echo "Syncing to s3://${BUCKET_NAME} ..."
aws s3 sync "$DIST_DIR" "s3://${BUCKET_NAME}" --delete

echo "Invalidating CloudFront ${DISTRIBUTION_ID} ..."
aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION_ID" \
  --paths "/*" \
  --query "Invalidation.Id" \
  --output text

echo ""
echo "Done. $DISTRIBUTION_URL"
