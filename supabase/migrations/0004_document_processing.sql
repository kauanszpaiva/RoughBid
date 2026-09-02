alter table public.project_files
  add column processing_status text not null default 'uploading'
    check (processing_status in ('uploading', 'queued', 'processing', 'ready', 'failed')),
  add column processing_error text,
  add column page_count integer check (page_count is null or page_count > 0),
  add column metadata jsonb not null default '{}'::jsonb;

create table public.project_file_pages (
  id bigint generated always as identity primary key,
  file_id uuid not null references public.project_files(id) on delete cascade,
  page_number integer not null check (page_number > 0),
  storage_path text not null unique,
  mime_type text not null check (mime_type = 'image/jpeg'),
  byte_size bigint not null check (byte_size > 0),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  created_at timestamptz not null default now(),
  unique (file_id, page_number)
);

alter table public.project_file_pages enable row level security;
create policy "workspace members can read processed plan pages"
on public.project_file_pages for select to authenticated
using (exists (
  select 1 from public.project_files f
  where f.id = project_file_pages.file_id
    and private.has_workspace_access(f.workspace_id)
    and private.has_product_access()
));

revoke insert, update, delete on public.project_file_pages from authenticated, anon;
