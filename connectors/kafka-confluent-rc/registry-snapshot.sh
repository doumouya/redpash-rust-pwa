#!/usr/bin/env bash
# Purpose: snapshot the Confluent Schema Registry's GOVERNANCE STATE — global
#   mode + compatibility, the subject/version catalog, and per-subject
#   compatibility/mode overrides — to registry/snapshot.json. This complements
#   `bootstrap-contracts` (spike.mjs), which captures the SCHEMAS (the data
#   contract under contracts/). Data contract = "what the records look like";
#   registry snapshot = "what the registry's rules + catalog are".
# Doc: connectors/kafka-confluent-rc/README.md
#
# Usage:   bash connectors/kafka-confluent-rc/registry-snapshot.sh
# Reads SCHEMA_REGISTRY_URL / _KEY / _SECRET from this dir's .env (read-only GETs).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/.env" ] || { echo "✗ missing $HERE/.env (SCHEMA_REGISTRY_*)"; exit 1; }
set -a; . "$HERE/.env"; set +a
: "${SCHEMA_REGISTRY_URL:?}" "${SCHEMA_REGISTRY_KEY:?}" "${SCHEMA_REGISTRY_SECRET:?}"

SR="$SCHEMA_REGISTRY_URL"
AUTH="$SCHEMA_REGISTRY_KEY:$SCHEMA_REGISTRY_SECRET"
sr()     { curl -fsS -u "$AUTH" "$SR$1"; }                    # required: fail on error
sr_opt() { curl -fsS -u "$AUTH" "$SR$1" 2>/dev/null || echo 'null'; }  # 404 → null

mode=$(sr /mode)
config=$(sr /config)
subjects=$(sr /subjects)

subj_json='[]'
for s in $(echo "$subjects" | jq -r '.[]'); do
  enc=$(jq -rn --arg s "$s" '$s|@uri')
  versions=$(sr "/subjects/$enc/versions")
  scfg=$(sr_opt "/config/$enc")     # per-subject compatibility override, or null
  smode=$(sr_opt "/mode/$enc")      # per-subject mode override, or null
  latest=$(sr "/subjects/$enc/versions/latest")
  entry=$(jq -n \
    --arg s "$s" \
    --argjson v "$versions" \
    --argjson c "$scfg" \
    --argjson m "$smode" \
    --argjson lid "$(echo "$latest" | jq '.id')" \
    --argjson lver "$(echo "$latest" | jq '.version')" \
    --arg ltype "$(echo "$latest" | jq -r '.schemaType // "AVRO"')" \
    '{subject:$s, versions:$v,
      compatibility:(if $c==null then null else ($c.compatibilityLevel // $c.compatibility) end),
      mode:(if $m==null then null else $m.mode end),
      latest:{version:$lver, id:$lid, schemaType:$ltype}}')
  subj_json=$(echo "$subj_json" | jq --argjson e "$entry" '. + [$e]')
done

snapshot=$(jq -n \
  --arg url "$SR" \
  --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson mode "$mode" \
  --argjson config "$config" \
  --argjson subjects "$subj_json" \
  '{fetched_at:$at, registry_url:$url,
    global:{mode:$mode.mode, compatibility:($config.compatibilityLevel // $config.compatibility)},
    subject_count:($subjects|length),
    subjects:$subjects}')

mkdir -p "$HERE/registry"
echo "$snapshot" > "$HERE/registry/snapshot.json"
echo "── schema registry snapshot → $HERE/registry/snapshot.json"
echo "$snapshot" | jq .
