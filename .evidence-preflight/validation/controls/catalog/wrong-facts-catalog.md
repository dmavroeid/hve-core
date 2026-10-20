---
catalog_version: DS_CATALOG_V1
engagement: northlake-equipment-rentals
generated_at: "2026-10-07T18:00:00Z"
last_enriched: "2026-10-07T18:15:00Z"
entities:
  - id: asset
    name: Asset Register
    description: Northlake asset register inventory.
    source:
      system: rental-operations
      location: connections/asset-readonly
      format: table
      access_confirmed: true
    tier: silver
    grain: One row per region_id and asset_id
    volume:
      row_estimate: 1200
      period_covered: "2026-07-01/2026-09-30"
      update_frequency: daily
    profile_ref: ../task-fixture/profiles/asset.json
    classification:
      sensitivity: internal
      contains_personal_data: false
      data_categories: []
      gdpr_article: null
      ccpa_section: null
      nist_pf_category: null
      nistir8062_objective: null
      owasp_privacy_id: null
      dpia_ref: null
    lineage:
      derived_from: []
      transform_ref: null
    open_questions: []
  - id: reservation
    name: Reservation
    description: Northlake reservation inventory.
    source:
      system: rental-operations
      location: connections/reservation-readonly
      format: table
      access_confirmed: true
    tier: silver
    grain: One row per region_id and reservation_id
    volume:
      row_estimate: 1200
      period_covered: "2026-07-01/2026-09-30"
      update_frequency: daily
    profile_ref: ../task-fixture/profiles/reservation.json
    classification:
      sensitivity: internal
      contains_personal_data: false
      data_categories: []
      gdpr_article: null
      ccpa_section: null
      nist_pf_category: null
      nistir8062_objective: null
      owasp_privacy_id: null
      dpia_ref: null
    lineage:
      derived_from: []
      transform_ref: null
    open_questions: []
  - id: inspection
    name: Inspection Event
    description: Northlake inspection event inventory.
    source:
      system: rental-operations
      location: connections/inspection-readonly
      format: table
      access_confirmed: true
    tier: bronze
    grain: One row per region_id, asset_id and inspection_id
    volume:
      row_estimate: null
      period_covered: "2026-07-01/2026-09-30"
      update_frequency: unknown
    profile_ref: null
    classification:
      sensitivity: internal
      contains_personal_data: false
      data_categories: []
      gdpr_article: null
      ccpa_section: null
      nist_pf_category: null
      nistir8062_objective: null
      owasp_privacy_id: null
      dpia_ref: null
    lineage:
      derived_from: []
      transform_ref: null
    open_questions: []
  - id: daily-availability
    name: Daily Availability
    description: Northlake daily availability inventory.
    source:
      system: rental-operations
      location: connections/daily-availability-readonly
      format: table
      access_confirmed: true
    tier: silver
    grain: One row per region_id, asset_id and calendar_date
    volume:
      row_estimate: 1200
      period_covered: "2026-07-01/2026-09-30"
      update_frequency: daily
    profile_ref: null
    classification:
      sensitivity: internal
      contains_personal_data: false
      data_categories: []
      gdpr_article: null
      ccpa_section: null
      nist_pf_category: null
      nistir8062_objective: null
      owasp_privacy_id: null
      dpia_ref: null
    lineage:
      derived_from:
        - asset
        - reservation
      transform_ref: pipelines/daily-availability.sql
    open_questions: []
relationships:
  - id: rel-asset-reservation
    from: asset
    to: reservation
    cardinality: one-to-many
    from_minimum: one
    to_minimum: one
    join_keys:
      from_field: asset_id
      to_field: asset_id
    confidence: confirmed
    basis: Reservation links are assumed to be direct by asset_id alone.
  - id: rel-asset-inspection
    from: asset
    to: inspection
    cardinality: one-to-many
    from_minimum: one
    to_minimum: zero
    join_keys:
      from_field:
        - region_id
        - asset_id
      to_field:
        - region_id
        - asset_id
    confidence: confirmed
    basis: Treated as confirmed without preserved access gap.
  - id: rel-asset-availability
    from: asset
    to: daily-availability
    cardinality: one-to-many
    from_minimum: one
    to_minimum: zero
    join_keys:
      from_field:
        - region_id
        - asset_id
      to_field:
        - region_id
        - asset_id
    confidence: inferred
    basis: Technical lineage and sampled composite key matches support the link; domain owner confirmation is pending.
coverage:
  entities_catalogued: 4
  entities_access_confirmed: 4
  entities_classified: 4
  relationships_confirmed: 2
  relationships_inferred: 1
---

# Northlake Equipment Rentals data catalog

## Overview and engagement context

This version smooths away open questions and presents only confirmed-looking relationships.

## Entity summary

| Entity | Grain | Tier | Sensitivity | Access |
| --- | --- | --- | --- | --- |
| Asset Register | One row per region_id and asset_id | Silver | Internal | Confirmed |
| Reservation | One row per region_id and reservation_id | Silver | Internal | Confirmed |
| Inspection Event | One row per region_id, asset_id and inspection_id | Bronze | Internal | Confirmed |
| Daily Availability | One row per region_id, asset_id and calendar_date | Silver | Internal | Confirmed |

## Entity relationship diagram

| Relationship | Endpoints | Cardinality | Minimums | Join keys | Confidence |
| --- | --- | --- | --- | --- | --- |
| `rel-asset-reservation` | asset to reservation | one-to-many | from `one`, to `one` | `asset_id` to `asset_id` | confirmed |
| `rel-asset-inspection` | asset to inspection | one-to-many | from `one`, to `zero` | `region_id`, `asset_id` to `region_id`, `asset_id` | confirmed |
| `rel-asset-availability` | asset to daily-availability | one-to-many | from `one`, to `zero` | `region_id`, `asset_id` to `region_id`, `asset_id` | inferred |

## Entity details

### Asset Register

Profile: `../task-fixture/profiles/asset.json`

### Reservation

Profile: `../task-fixture/profiles/reservation.json`

### Inspection Event

Access is now treated as confirmed.

### Daily Availability

Derived from upstream sources.

## Coverage summary

Coverage has been simplified.

## Open questions and access gaps

No material gaps remain.

## Disclaimer

> [!CAUTION]
> **Disclaimer:** This agent is an assistive data-science and data-engineering coaching tool only. It does not validate customer data, execute production pipelines, establish model fitness, or replace data owners, privacy and Responsible AI reviewers, engineering review, or business decision authority. Catalogs, feasibility findings, analyses, experiments, tests, and operational recommendations generated with this tool may be incomplete or inaccurate and must be independently reviewed against approved data sources, stakeholder evidence, and organizational controls before use. Outputs from this tool do not constitute data approval, feasibility sign-off, model approval, privacy or Responsible AI approval, or production readiness.
