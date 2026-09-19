-- Corvis authoritative data-right hardening v1
-- Depends on 003_operations_delivery_governance.sql and authorization subjects.
--
-- corvis_control.data_rights is a contractual/control-plane input. Application
-- authorization treats missing active rights as deny, and overlapping active rows
-- use deny-wins aggregation. Client code must never mutate this table directly.

begin;

alter table corvis_control.data_rights enable row level security;
alter table corvis_control.data_rights force row level security;

create index if not exists data_rights_active_resource_idx
  on corvis_control.data_rights (tenant_id, resource_type, resource_id, effective_from, effective_to);

comment on table corvis_control.data_rights is
  'Server-managed authoritative contractual data rights. Missing current rights fail closed; overlapping current rights are evaluated deny-wins by application authorization.';
comment on column corvis_control.data_rights.source_document_access_allowed is
  'Controls access to underlying source evidence independently from client-visible derived data.';
comment on column corvis_control.data_rights.redistribution_allowed is
  'Controls outbound redistribution/export independently from application RBAC.';

commit;
