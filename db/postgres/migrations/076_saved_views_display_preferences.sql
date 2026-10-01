-- UX state only; none of these columns grants resource access.
begin;
alter table corvis_control.workspace_user_preference
  add column display_preferences jsonb,
  add column saved_views jsonb not null default '[]'::jsonb,
  add column view_defaults jsonb not null default '{}'::jsonb,
  add constraint saved_views_array check (jsonb_typeof(saved_views)='array' and jsonb_array_length(saved_views)<=100),
  add constraint view_defaults_object check (jsonb_typeof(view_defaults)='object'),
  add constraint display_preferences_object check (display_preferences is null or jsonb_typeof(display_preferences)='object');
commit;
