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
      sensitivity: confidential
      contains_personal_data: true
      data_categories:
        - customer-reference
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
      access_confirmed: false
    tier: bronze
    grain: One row per region_id, asset_id and inspection_id
    volume:
      row_estimate: null
      period_covered: "2026-07-01/2026-09-30"
      update_frequency: unknown
    profile_ref: ../task-fixture/profiles/inspection-2025.json
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
    open_questions:
      - Access is not confirmed; the 2025 profile is stale and unavailable in this bundle.
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
    to_minimum: zero
    join_keys:
      from_field:
        - region_id
        - asset_id
      to_field:
        - region_id
        - asset_id
    confidence: confirmed
    basis: The rental domain owner confirmed every reservation references one asset; an asset may have no reservations.
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
    confidence: assumed
    basis: Workshop proposal with explicit one-asset/zero-or-more-inspections minima; source access and owner confirmation are outstanding.
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
  entities_access_confirmed: 3
  entities_classified: 4
  relationships_confirmed: 1
  relationships_inferred: 1
---

# Northlake Equipment Rentals data catalog

## Overview and engagement context

This catalog captures the current rental-operations discovery state for Northlake Equipment Rentals. It keeps confirmed records, inferred lineage, access gaps, and unresolved evidence visible so reviewers can plan next enrichment steps without mistaking assumptions for confirmed facts.

## Entity summary

| Entity | Grain | Tier | Sensitivity | Access |
| --- | --- | --- | --- | --- |
| Asset Register | One row per region_id and asset_id | Silver | Internal | Confirmed |
| Reservation | One row per region_id and reservation_id | Silver | Confidential | Confirmed |
| Inspection Event | One row per region_id, asset_id and inspection_id | Bronze | Internal | Unconfirmed |
| Daily Availability | One row per region_id, asset_id and calendar_date | Silver | Internal | Confirmed |

## Entity relationship diagram

The declared relationships below are the text equivalent for any later rendered diagram. The composite join keys stay paired by position and the confidence labels remain authoritative.

| Relationship | Endpoints | Cardinality | Minimums | Join keys | Confidence |
| --- | --- | --- | --- | --- | --- |
| `rel-asset-reservation` | asset to reservation | one-to-many | from `one`, to `zero` | `region_id`, `asset_id` to `region_id`, `asset_id` | confirmed |
| `rel-asset-inspection` | asset to inspection | one-to-many | from `one`, to `zero` | `region_id`, `asset_id` to `region_id`, `asset_id` | assumed |
| `rel-asset-availability` | asset to daily-availability | one-to-many | from `one`, to `zero` | `region_id`, `asset_id` to `region_id`, `asset_id` | inferred |

## Entity details

### Asset Register

The asset register is a confirmed silver source in rental-operations. Its profile attachment remains at `../task-fixture/profiles/asset.json`.

### Reservation

Reservations are confirmed and confidential because they contain personal customer-reference data. The profile attachment remains at `../task-fixture/profiles/reservation.json`.

### Inspection Event

Inspection events remain access-unconfirmed bronze data. The catalog keeps the stale pointer `../task-fixture/profiles/inspection-2025.json` rather than inventing a replacement profile, and it preserves the open question: Access is not confirmed; the 2025 profile is stale and unavailable in this bundle.

### Daily Availability

Daily availability is a silver derived table built from `asset` and `reservation` through `pipelines/daily-availability.sql`. No profile attachment is available yet.

## Coverage summary

Four entities are catalogued. Three have confirmed access. Four count as classified because each entity has a non-`none` sensitivity value. Among the three declared relationships, one is confirmed, one is inferred, and one remains assumed.

## Open questions and access gaps

* Access is not confirmed; the 2025 profile is stale and unavailable in this bundle.
* Confirm the inspection source and secure a current profile attachment before upgrading the relationship confidence.

## Disclaimer

> [!CAUTION]
> **Disclaimer:** This agent is an assistive data-science and data-engineering coaching tool only. It does not validate customer data, execute production pipelines, establish model fitness, or replace data owners, privacy and Responsible AI reviewers, engineering review, or business decision authority. Catalogs, feasibility findings, analyses, experiments, tests, and operational recommendations generated with this tool may be incomplete or inaccurate and must be independently reviewed against approved data sources, stakeholder evidence, and organizational controls before use. Outputs from this tool do not constitute data approval, feasibility sign-off, model approval, privacy or Responsible AI approval, or production readiness.
