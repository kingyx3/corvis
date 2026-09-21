-- Tighten lifecycle participant identity/role uniqueness.
-- Depends on migration 032.
--
-- PostgreSQL UNIQUE constraints containing nullable alternative foreign keys do
-- not prevent duplicate rows for the populated side because NULL values remain
-- distinct. Partial indexes enforce the actual polymorphic invariant.

begin;

create unique index if not exists entity_lifecycle_participant_fund_role_uniq
  on corvis_identity.entity_lifecycle_participant
    (lifecycle_event_id, fund_id, participant_role)
  where fund_id is not null;

create unique index if not exists entity_lifecycle_participant_company_role_uniq
  on corvis_identity.entity_lifecycle_participant
    (lifecycle_event_id, company_id, participant_role)
  where company_id is not null;

commit;
