-- App-identity routing: which product a feature belongs to. The chat's research
-- tools resolve repo + base branch from lib/claude/apps.ts using this slug, so
-- CMS/mobile/desktop features stop being researched against the web repo.
alter table features
  add column if not exists app text not null default 'web'
    check (app in ('web', 'cms', 'mobile', 'desktop'));

comment on column features.app
  is 'Target application: web (app.viscap.ai@develop), cms (education-cms@develop), mobile (media-sync-mobile@main), desktop (media-sync-desktop@main). Registry: lib/claude/apps.ts.';
