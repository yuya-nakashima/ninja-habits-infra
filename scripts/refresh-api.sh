#!/usr/bin/env bash
# Trigger an ASG instance refresh for the API stack so new instances boot the
# currently-promoted artifact (deploy.md §6.1 step 4). This is the LAST step of a
# release: run it only AFTER 'set-api-artifact.sh promote' (and after migration).
#
# Usage:
#   STAGE=<stage> bash scripts/refresh-api.sh
#
# Env (optional):
#   MIN_HEALTHY_PERCENT  default 90   # keep this % in service during replacement
#   INSTANCE_WARMUP      default 300  # seconds before an instance counts as healthy
#   MAX_WAIT             default 1800 # seconds to poll before giving up (refresh keeps running)
#   POLL_INTERVAL        default 15   # seconds between status polls
#
# Exit codes:
#   0  refresh Successful
#   1  refresh Failed / Cancelled / RollbackSuccessful / RollbackFailed
#   2  still in progress at MAX_WAIT (NOT a failure; rerun resumes the same refresh)
# Reruns are idempotent: an already Pending/InProgress refresh is polled, not restarted.
# CAVEAT: this reuse assumes ONE release per stage at a time. If a different
# release overlaps, this attaches to the prior release's in-progress refresh
# (which may target the old artifact) and cannot guarantee a full swap to the new
# one. The CI workflow MUST serialize releases per stage (stage-level concurrency).
#
# Prerequisites: aws CLI configured, NinjaHabits-<stage>-Api already deployed.

set -euo pipefail

STAGE="${STAGE:-dev}"
AWS_REGION="${AWS_REGION:-ap-northeast-1}"
API_STACK="NinjaHabits-${STAGE}-Api"
MIN_HEALTHY_PERCENT="${MIN_HEALTHY_PERCENT:-90}"
INSTANCE_WARMUP="${INSTANCE_WARMUP:-300}"
MAX_WAIT="${MAX_WAIT:-1800}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"

ASG_NAME="$(aws cloudformation describe-stacks \
  --region "$AWS_REGION" \
  --stack-name "$API_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiAutoScalingGroupName'].OutputValue" \
  --output text)"
if [ -z "$ASG_NAME" ] || [ "$ASG_NAME" = "None" ]; then
  echo "Error: could not resolve ApiAutoScalingGroupName from $API_STACK. Deploy the Api stack first." >&2
  exit 1
fi

echo "ASG: $ASG_NAME"

# Idempotent reruns: if a refresh is already Pending/InProgress (e.g. a previous
# CI run that exited on MAX_WAIT), poll THAT one instead of failing on
# start-instance-refresh (which errors while a refresh is in progress).
EXISTING="$(aws autoscaling describe-instance-refreshes \
  --region "$AWS_REGION" \
  --auto-scaling-group-name "$ASG_NAME" \
  --query 'InstanceRefreshes[?Status==`Pending`||Status==`InProgress`]|[0].InstanceRefreshId' \
  --output text)"

if [ -n "$EXISTING" ] && [ "$EXISTING" != "None" ]; then
  REFRESH_ID="$EXISTING"
  echo "Reusing in-progress instance refresh: $REFRESH_ID"
else
  echo "Starting instance refresh (MinHealthyPercentage=${MIN_HEALTHY_PERCENT}, InstanceWarmup=${INSTANCE_WARMUP}s)"
  REFRESH_ID="$(aws autoscaling start-instance-refresh \
    --region "$AWS_REGION" \
    --auto-scaling-group-name "$ASG_NAME" \
    --preferences "MinHealthyPercentage=${MIN_HEALTHY_PERCENT},InstanceWarmup=${INSTANCE_WARMUP}" \
    --query 'InstanceRefreshId' \
    --output text)"
  echo "Instance refresh: $REFRESH_ID"
fi

# Poll until a terminal state or MAX_WAIT. The refresh keeps running on AWS even
# if we stop polling, so a timeout here is not a failure of the refresh itself.
elapsed=0
while :; do
  INFO="$(aws autoscaling describe-instance-refreshes \
    --region "$AWS_REGION" \
    --auto-scaling-group-name "$ASG_NAME" \
    --instance-refresh-ids "$REFRESH_ID" \
    --query 'InstanceRefreshes[0].[Status,PercentageComplete]' \
    --output text)"
  STATUS="$(printf '%s' "$INFO" | awk '{print $1}')"
  PCT="$(printf '%s' "$INFO" | awk '{print $2}')"
  echo "  status=${STATUS} complete=${PCT:-0}% (${elapsed}s)"

  case "$STATUS" in
    Successful)
      echo "Instance refresh succeeded."
      exit 0
      ;;
    Failed|Cancelled|RollbackSuccessful|RollbackFailed)
      echo "Instance refresh ended with status=${STATUS}." >&2
      echo "Rollback: 'set-api-artifact.sh promote <previous-key>' then re-run this script (deploy.md §6.1)." >&2
      exit 1
      ;;
  esac

  if [ "$elapsed" -ge "$MAX_WAIT" ]; then
    echo "Stopped polling after ${MAX_WAIT}s; refresh ${REFRESH_ID} is still running on AWS (NOT failed)." >&2
    echo "Re-running this script resumes polling the SAME refresh (it reuses the in-progress one)." >&2
    echo "For a single CI step, raise MAX_WAIT, or treat exit code 2 as 'still in progress' rather than failure." >&2
    exit 2
  fi
  sleep "$POLL_INTERVAL"
  elapsed=$((elapsed + POLL_INTERVAL))
done
