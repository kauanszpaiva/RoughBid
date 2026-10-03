-- REVIEW ONLY. Additive human-reviewed measurements; no production application.
-- Native outlines stay candidates. LF/SF require two independent references in
-- the same file/page/region revision. EA requires reviewed element identity.
create table public.takeoff_measurement_reviews (
  id uuid primary key,
  takeoff_run_id uuid not null,
  workspace_id uuid not null,
  project_id uuid not null,
  file_id uuid not null,
  plan_sheet_id uuid not null,
  file_sha256 text not null check(file_sha256~'^[a-f0-9]{64}$'),
  physical_page_number integer not null check(physical_page_number between 1 and 200),
  page_sha256 text not null check(page_sha256~'^[a-f0-9]{64}$'),
  region_key text not null check(length(region_key) between 1 and 120),
  region_bounds jsonb not null check(jsonb_typeof(region_bounds)='array' and jsonb_array_length(region_bounds)=4),
  canonical_element_key text not null check(length(canonical_element_key) between 1 and 120),
  canonical_trade text not null check(length(canonical_trade) between 1 and 80),
  label text not null check(length(label) between 1 and 240),
  geometry jsonb not null check(jsonb_typeof(geometry)='object'),
  geometry_fingerprint text not null,
  source_kind text not null check(source_kind in ('manual_trace','native_vector_candidate','manual_observed_count')),
  source_candidate_id text,
  quantity numeric(24,6),
  unit text check(unit in ('LF','SF','EA')),
  calibration jsonb,
  proof jsonb not null check(jsonb_typeof(proof)='object'),
  formula jsonb,
  method text not null check(method in ('reviewed_geometry','reviewed_visible_identity')),
  uncertainty jsonb not null default '[]' check(jsonb_typeof(uncertainty)='array'),
  review_status text not null check(review_status in ('candidate','accepted','rejected','blocked')),
  review_revision integer not null default 1 check(review_revision>0),
  reviewed_by uuid not null references auth.users(id) on delete restrict,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint measurement_review_run_scope_fkey foreign key(takeoff_run_id,workspace_id,project_id,file_id)
    references public.takeoff_runs(id,workspace_id,project_id,file_id) on delete cascade,
  constraint measurement_review_sheet_scope_fkey foreign key(plan_sheet_id,workspace_id,project_id,takeoff_run_id)
    references public.plan_sheets(id,workspace_id,project_id,takeoff_run_id) on delete cascade,
  constraint measurement_review_quantity_gate check(
    (review_status='accepted' and quantity is not null and quantity>0 and unit is not null and formula is not null)
    or (review_status<>'accepted' and quantity is null and unit is null and formula is null)),
  unique(id,workspace_id,project_id)
);
create unique index measurement_review_element_dedupe_idx on public.takeoff_measurement_reviews(takeoff_run_id,canonical_trade,canonical_element_key) where review_status='accepted';
create unique index measurement_review_geometry_dedupe_idx on public.takeoff_measurement_reviews(takeoff_run_id,plan_sheet_id,canonical_trade,geometry_fingerprint) where review_status='accepted';
create index measurement_review_run_page_idx on public.takeoff_measurement_reviews(takeoff_run_id,workspace_id,project_id,physical_page_number);
create index measurement_review_sheet_scope_idx on public.takeoff_measurement_reviews(plan_sheet_id,workspace_id,project_id,takeoff_run_id);

create table public.takeoff_measurement_review_events (
  id uuid primary key default gen_random_uuid(),
  measurement_id uuid not null references public.takeoff_measurement_reviews(id) on delete restrict,
  workspace_id uuid not null,
  project_id uuid not null,
  reviewer_id uuid not null references auth.users(id) on delete restrict,
  revision integer not null check(revision>0),
  snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
  created_at timestamptz not null default now(),
  unique(measurement_id,revision),
  foreign key(measurement_id,workspace_id,project_id) references public.takeoff_measurement_reviews(id,workspace_id,project_id) on delete restrict
);
create index measurement_review_events_scope_idx on public.takeoff_measurement_review_events(workspace_id,project_id,measurement_id);
alter table public.takeoff_measurement_reviews enable row level security;
alter table public.takeoff_measurement_review_events enable row level security;
create policy measurement_reviews_read on public.takeoff_measurement_reviews for select to authenticated
  using(private.has_workspace_role(workspace_id,array['admin','estimator','viewer']) and private.has_product_access());
create policy measurement_review_events_read on public.takeoff_measurement_review_events for select to authenticated
  using(private.has_workspace_role(workspace_id,array['admin','estimator','viewer']) and private.has_product_access());
revoke all on public.takeoff_measurement_reviews,public.takeoff_measurement_review_events from public,anon,authenticated,service_role;
grant select on public.takeoff_measurement_reviews,public.takeoff_measurement_review_events to authenticated,service_role;

create or replace function private.measurement_segments_cross(a jsonb,b jsonb,c jsonb,d jsonb)
returns boolean language sql immutable set search_path=pg_catalog as $$
  with p as(select (a->>0)::numeric ax,(a->>1)::numeric ay,(b->>0)::numeric bx,(b->>1)::numeric by,(c->>0)::numeric cx,(c->>1)::numeric cy,(d->>0)::numeric dx,(d->>1)::numeric dy)
  select ((bx-ax)*(cy-ay)-(by-ay)*(cx-ax))*((bx-ax)*(dy-ay)-(by-ay)*(dx-ax))<=0
    and ((dx-cx)*(ay-cy)-(dy-cy)*(ax-cx))*((dx-cx)*(by-cy)-(dy-cy)*(bx-cx))<=0
    and greatest(least(ax,bx),least(cx,dx))<=least(greatest(ax,bx),greatest(cx,dx))
    and greatest(least(ay,by),least(cy,dy))<=least(greatest(ay,by),greatest(cy,dy)) from p
$$;

-- Direction, polygon starting vertex, equivalent rectangle/polygon encoding and
-- overlapping review regions cannot turn the same physical geometry into two quantities.
create or replace function private.measurement_geometry_fingerprint(g jsonb)
returns text language plpgsql immutable set search_path=pg_catalog as $$
declare kind text:=g->>'type';points_ jsonb:=g->'points';normalized jsonb:='[]';sequence_ jsonb;point_ jsonb;
  n integer;i integer;shift_ integer;direction_ integer;index_ integer;best text;candidate text;ax numeric;ay numeric;bx numeric;by_ numeric;
begin
  if kind='rectangle' then
    ax:=least((points_->0->>0)::numeric,(points_->1->>0)::numeric);ay:=least((points_->0->>1)::numeric,(points_->1->>1)::numeric);
    bx:=greatest((points_->0->>0)::numeric,(points_->1->>0)::numeric);by_:=greatest((points_->0->>1)::numeric,(points_->1->>1)::numeric);
    points_:=jsonb_build_array(jsonb_build_array(ax,ay),jsonb_build_array(bx,ay),jsonb_build_array(bx,by_),jsonb_build_array(ax,by_));kind:='polygon';
  end if;
  for point_ in select value from jsonb_array_elements(points_) loop
    normalized:=normalized||jsonb_build_array(jsonb_build_array(round((point_->>0)::numeric,9),round((point_->>1)::numeric,9)));
  end loop;
  n:=jsonb_array_length(normalized);
  for direction_ in 0..1 loop
    for shift_ in 0..case when kind='polygon' then n-1 else 0 end loop
      sequence_:='[]';
      for i in 0..n-1 loop
        index_:=case when direction_=0 then (shift_+i)%n else (shift_+n-i)%n end;
        if kind<>'polygon' and direction_=1 then index_:=n-1-i;end if;
        sequence_:=sequence_||jsonb_build_array(normalized->index_);
      end loop;
      candidate:=sequence_::text;if best is null or candidate<best then best:=candidate;end if;
    end loop;
  end loop;
  return md5(case when kind in ('line','polyline') then 'path' when kind in ('point','count') then 'identity' else 'surface' end||':'||best);
end $$;

create or replace function private.measurement_is_native_extent(g jsonb,bbox jsonb)
returns boolean language plpgsql immutable set search_path=pg_catalog as $$
declare points_ jsonb:=g->'points';kind text:=g->>'type';point_ jsonb;next_ jsonb;i integer;n integer;
  x numeric:=(bbox->>0)::numeric;y numeric:=(bbox->>1)::numeric;w numeric:=(bbox->>2)::numeric;h numeric:=(bbox->>3)::numeric;
  px numeric;py numeric;twice_area numeric:=0;epsilon constant numeric:=0.000000001;
begin
  if w is null or h is null or w<=0 or h<=0 then return false;end if;
  if kind='rectangle' then
    return abs(least((points_->0->>0)::numeric,(points_->1->>0)::numeric)-x)<=epsilon
      and abs(least((points_->0->>1)::numeric,(points_->1->>1)::numeric)-y)<=epsilon
      and abs(abs((points_->0->>0)::numeric-(points_->1->>0)::numeric)-w)<=epsilon
      and abs(abs((points_->0->>1)::numeric-(points_->1->>1)::numeric)-h)<=epsilon;
  end if;
  if kind<>'polygon' then return false;end if;
  n:=jsonb_array_length(points_);
  for i in 0..n-1 loop
    point_:=points_->i;next_:=points_->((i+1)%n);px:=(point_->>0)::numeric;py:=(point_->>1)::numeric;
    if px<x-epsilon or px>x+w+epsilon or py<y-epsilon or py>y+h+epsilon
      or not(abs(px-x)<=epsilon or abs(px-x-w)<=epsilon or abs(py-y)<=epsilon or abs(py-y-h)<=epsilon) then return false;end if;
    twice_area:=twice_area+px*(next_->>1)::numeric-(next_->>0)::numeric*py;
  end loop;
  return abs(abs(twice_area)/2-w*h)<=epsilon;
end $$;

create or replace function private.calculate_reviewed_measurement(p_review jsonb,p_width numeric,p_height numeric)
returns jsonb language plpgsql set search_path=public,private,pg_temp as $$
declare bounds jsonb;g jsonb;points jsonb;kind text;point jsonb;ref jsonb;line jsonb;count_points integer;i integer;j integer;
  bx numeric;by_ numeric;bw numeric;bh numeric;x numeric;y numeric;dx numeric;dy numeric;distance numeric;ratio numeric;ratio_mean numeric;
  ratios numeric[]:='{}';ids text[]:='{}';excerpts text[]:='{}';lines text[]:='{}';canonical_line text;feet numeric;
  qty numeric:=0;twice_area numeric:=0;unit_ text;calibration jsonb:=null;formula jsonb:=null;ref_count integer;
begin
  if jsonb_typeof(p_review) is distinct from 'object' or p_width<=0 or p_height<=0 then raise exception 'Invalid measurement input'; end if;
  bounds:=p_review->'regionBounds';g:=p_review->'geometry';points:=g->'points';kind:=g->>'type';
  if jsonb_typeof(bounds) is distinct from 'array' or jsonb_array_length(bounds)<>4
     or exists(select 1 from jsonb_array_elements(bounds) b where jsonb_typeof(b)<>'number') then raise exception 'Invalid measurement region'; end if;
  bx:=(bounds->>0)::numeric;by_:=(bounds->>1)::numeric;bw:=(bounds->>2)::numeric;bh:=(bounds->>3)::numeric;
  if bx<0 or by_<0 or bw<=0 or bh<=0 or bx+bw>1.000000001 or by_+bh>1.000000001 then raise exception 'Invalid measurement region'; end if;
  if jsonb_typeof(g) is distinct from 'object' or coalesce(kind,'') not in ('line','polyline','polygon','rectangle','point','count')
     or jsonb_typeof(points) is distinct from 'array' then raise exception 'Invalid measurement geometry'; end if;
  count_points:=jsonb_array_length(points);
  if kind not in ('point','count') and p_review->>'sourceKind'='manual_observed_count' then raise exception 'Observed counts require a point identity'; end if;
  if count_points not between 1 and 128 or kind in ('line','rectangle') and count_points<>2 or kind in ('point','count') and count_points<>1
     or kind='polygon' and count_points<3 or kind='polyline' and count_points<2 then raise exception 'Invalid measurement vertices'; end if;
  for point in select value from jsonb_array_elements(points) loop
    if jsonb_typeof(point)<>'array' or jsonb_array_length(point)<>2 or jsonb_typeof(point->0)<>'number' or jsonb_typeof(point->1)<>'number' then raise exception 'Invalid geometry coordinate'; end if;
    x:=(point->>0)::numeric;y:=(point->>1)::numeric;
    if x<0 or y<0 or x>1 or y>1 or x<bx or y<by_ or x>bx+bw+0.000000001 or y>by_+bh+0.000000001 then raise exception 'Geometry outside reviewed region'; end if;
  end loop;
  if (select count(distinct value) from jsonb_array_elements(points))<>count_points then raise exception 'Duplicate geometry vertices'; end if;
  if kind='polygon' then
    for i in 0..count_points-1 loop for j in i+1..count_points-1 loop
      if j<count_points and j<>i+1 and not(i=0 and j=count_points-1)
        and private.measurement_segments_cross(points->i,points->((i+1)%count_points),points->j,points->((j+1)%count_points)) then raise exception 'Self-intersecting measurement polygon'; end if;
    end loop;end loop;
  end if;
  if jsonb_typeof(p_review->'uncertainty') is distinct from 'array' or jsonb_array_length(p_review->'uncertainty')>20
     or exists(select 1 from jsonb_array_elements(p_review->'uncertainty') u where jsonb_typeof(u)<>'string' or length(u#>>'{}') not between 1 and 240) then raise exception 'Invalid measurement uncertainty'; end if;
  if jsonb_typeof(p_review->'calibrationEvidence') is distinct from 'array' then raise exception 'Invalid calibration evidence'; end if;
  ref_count:=jsonb_array_length(p_review->'calibrationEvidence');
  if ref_count>8 then raise exception 'Too many calibration references'; end if;
  for ref in select value from jsonb_array_elements(p_review->'calibrationEvidence') loop
    if jsonb_typeof(ref)<>'object' or coalesce(ref->>'sourceType','') not in ('printed_scale','graphic_scale','explicit_dimension','known_reference')
       or coalesce(ref->>'unit','') not in ('ft','m','in') or jsonb_typeof(ref->'drawingLength') is distinct from 'number'
       or jsonb_typeof(ref->'pdfPoints') is distinct from 'number' or ref->'independenceVerified' is distinct from 'true'::jsonb
       or length(coalesce(btrim(ref->>'sourceId'),'')) not between 1 and 120 or length(coalesce(btrim(ref->>'sourceExcerpt'),'')) not between 1 and 1200 then raise exception 'Invalid independent scale reference'; end if;
    line:=ref->'referenceLine';
    if jsonb_typeof(line) is distinct from 'array' or jsonb_array_length(line)<>2 then raise exception 'Invalid reference line'; end if;
    for point in select value from jsonb_array_elements(line) loop
      if jsonb_typeof(point)<>'array' or jsonb_array_length(point)<>2 or jsonb_typeof(point->0)<>'number' or jsonb_typeof(point->1)<>'number' then raise exception 'Invalid reference coordinate'; end if;
      x:=(point->>0)::numeric;y:=(point->>1)::numeric;
      if x<bx or y<by_ or x>bx+bw+0.000000001 or y>by_+bh+0.000000001 then raise exception 'Reference outside reviewed region'; end if;
    end loop;
    dx:=((line->1->>0)::numeric-(line->0->>0)::numeric)*p_width;dy:=((line->1->>1)::numeric-(line->0->>1)::numeric)*p_height;
    distance:=sqrt(dx*dx+dy*dy);
    if distance<=0 or (ref->>'pdfPoints')::numeric<=0 or (ref->>'drawingLength')::numeric<=0
       or abs(distance-(ref->>'pdfPoints')::numeric)/distance>0.01 then raise exception 'Scale length differs from its geometry'; end if;
    canonical_line:=case when (line->0)::text<(line->1)::text then line::text else jsonb_build_array(line->1,line->0)::text end;
    if ref->>'sourceId'=any(ids) or btrim(ref->>'sourceExcerpt')=any(excerpts) or canonical_line=any(lines) then raise exception 'Repeated scale proof is not independent'; end if;
    ids:=array_append(ids,ref->>'sourceId');excerpts:=array_append(excerpts,btrim(ref->>'sourceExcerpt'));lines:=array_append(lines,canonical_line);
    feet:=(ref->>'drawingLength')::numeric*case ref->>'unit' when 'ft' then 1 when 'in' then 1.0/12 else 1.0/0.3048 end;
    ratios:=array_append(ratios,feet/(ref->>'pdfPoints')::numeric);
  end loop;
  if ref_count>0 then select avg(value) into ratio_mean from unnest(ratios) value;
    calibration:=jsonb_build_object('drawingUnitsPerPoint',ratio_mean,'unit','ft','verificationStatus',case when ref_count<2 then 'single_source' when exists(select 1 from unnest(ratios) r where abs(r-ratio_mean)/ratio_mean>0.01) then 'conflicting' else 'verified' end,'evidence',p_review->'calibrationEvidence'); end if;
  if p_review->>'decision'<>'accepted' then return jsonb_build_object('quantity',null,'unit',null,'formula',null,'calibration',calibration); end if;
  if p_review->'geometryReviewed' is distinct from 'true'::jsonb or p_review->'identityReviewed' is distinct from 'true'::jsonb
     or p_review->'duplicateReviewComplete' is distinct from 'true'::jsonb or jsonb_array_length(p_review->'uncertainty')<>0 then raise exception 'Independent human geometry/identity review is required'; end if;
  if kind in ('point','count') then
    qty:=1;unit_:='EA';formula:=jsonb_build_object('version','reviewed-count-v1','operation','one_distinct_reviewed_element','elementKey',p_review->>'canonicalElementKey');
  else
    if jsonb_typeof(p_review->'boundaryEvidence') is distinct from 'object' or p_review->'boundaryEvidence'->'reviewed' is distinct from 'true'::jsonb
      or coalesce(p_review->'boundaryEvidence'->>'method','') not in ('human_trace','verified_rectangular_surface')
      or length(coalesce(btrim(p_review->'boundaryEvidence'->>'sourceExcerpt'),'')) not between 1 and 1200 then raise exception 'Actual surface boundary review is required'; end if;
    if p_review->'boundaryEvidence'->>'method'='verified_rectangular_surface' and kind<>'rectangle' then raise exception 'Rectangular surface verification requires rectangular geometry'; end if;
    if p_review->>'sourceKind'='native_vector_candidate' and p_review->'boundaryEvidence'->>'method'<>'verified_rectangular_surface'
      and private.measurement_is_native_extent(g,p_review->'nativeCandidate'->'bbox') then raise exception 'Native extent is not a measured surface boundary'; end if;
    if ref_count<2 or calibration->>'verificationStatus'<>'verified' then raise exception 'Two agreeing independent scale references are required'; end if;
    ratio:=ratio_mean;
    if kind in ('line','polyline') then
      for i in 1..count_points-1 loop
        dx:=((points->i->>0)::numeric-(points->(i-1)->>0)::numeric)*p_width*ratio;dy:=((points->i->>1)::numeric-(points->(i-1)->>1)::numeric)*p_height*ratio;
        qty:=qty+sqrt(dx*dx+dy*dy);
      end loop;unit_:='LF';
    elsif kind='rectangle' then
      qty:=abs((points->1->>0)::numeric-(points->0->>0)::numeric)*p_width*ratio*abs((points->1->>1)::numeric-(points->0->>1)::numeric)*p_height*ratio;unit_:='SF';
    else
      for i in 0..count_points-1 loop j:=(i+1)%count_points;
        twice_area:=twice_area+((points->i->>0)::numeric*(points->j->>1)::numeric-(points->j->>0)::numeric*(points->i->>1)::numeric)*p_width*p_height*ratio*ratio;
      end loop;qty:=abs(twice_area)/2;unit_:='SF';
    end if;
    formula:=jsonb_build_object('version','geometry-v1','operation',case when unit_='LF' then 'sum(segment_length)' else 'shoelace_area' end,
      'inputs',jsonb_build_object('geometry',g,'pageWidthPoints',p_width,'pageHeightPoints',p_height,'drawingUnitsPerPoint',ratio));
  end if;
  qty:=round(qty,6);if qty<=0 then raise exception 'Zero or degenerate measurement is unresolved'; end if;
  return jsonb_build_object('quantity',qty,'unit',unit_,'formula',formula,'calibration',calibration);
end $$;

create or replace function public.record_takeoff_measurement_review(p_run_id uuid,p_workspace_id uuid,p_user_id uuid,p_review jsonb)
returns jsonb language plpgsql security definer set search_path=public,private,pg_temp as $$
declare r public.takeoff_runs;s public.plan_sheets;previous public.takeoff_measurement_reviews;saved public.takeoff_measurement_reviews;
  result jsonb;measurement_id uuid;page integer;expected integer;width_ numeric;height_ numeric;revision_ integer;state text;
begin
  if jsonb_typeof(p_review) is distinct from 'object' or octet_length(p_review::text)>50000 then raise exception 'Invalid bounded measurement review'; end if;
  perform 1 from public.profiles where id=p_user_id and is_platform_admin=true for share;
  if not found or not exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=p_user_id and role in ('admin','estimator'))
     or not exists(select 1 from public.workspaces where id=p_workspace_id and ai_processing_consented_at is not null) then raise exception 'Measurement review access denied'; end if;
  select * into r from public.takeoff_runs where id=p_run_id and workspace_id=p_workspace_id and mode='full' and orchestrator_version='takeoff-v2.2-durable' for share;
  if not found or p_review->>'fileSha256' is distinct from r.file_sha256 then raise exception 'Measurement file revision mismatch'; end if;
  measurement_id:=(p_review->>'measurementId')::uuid;page:=(p_review->>'physicalPageNumber')::integer;expected:=(p_review->>'expectedRevision')::integer;state:=p_review->>'decision';
  if measurement_id is null or page not between 1 and 200 or expected is null or expected<0 or state not in ('candidate','accepted','rejected','blocked')
    or coalesce(p_review->>'regionKey','')!~'^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$'
    or coalesce(p_review->>'canonicalElementKey','')!~'^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$'
    or coalesce(p_review->>'canonicalTrade','')!~'^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$'
    or length(coalesce(btrim(p_review->>'label'),'')) not between 1 and 240 or length(coalesce(btrim(p_review->>'sourceExcerpt'),'')) not between 1 and 1200
    or coalesce(p_review->>'sourceKind','') not in ('manual_trace','native_vector_candidate','manual_observed_count') then raise exception 'Invalid measurement review identity'; end if;
  if p_review->>'sourceKind'='native_vector_candidate' and (coalesce(p_review->>'sourceCandidateId','')!~'^[a-f0-9]{64}$'
     or p_review->'nativeCandidate'->>'id' is distinct from p_review->>'sourceCandidateId'
     or p_review->'nativeCandidate'->>'pageSha256' is distinct from p_review->>'pageSha256'
     or p_review->'nativeCandidate'->>'fileSha256' is distinct from r.file_sha256
     or p_review->'nativeCandidate'->>'physicalPageNumber' is distinct from p_review->>'physicalPageNumber'
     or p_review->'nativeCandidate'->>'source' is distinct from 'native_pdf_vector'
     or jsonb_typeof(p_review->'nativeCandidate'->'bbox') is distinct from 'array'
     or jsonb_array_length(p_review->'nativeCandidate'->'bbox')<>4
     or exists(select 1 from jsonb_array_elements(p_review->'nativeCandidate'->'bbox') coordinate where jsonb_typeof(coordinate)<>'number')) then raise exception 'Native candidate proof unavailable'; end if;
  select * into s from public.plan_sheets where takeoff_run_id=r.id and workspace_id=r.workspace_id and project_id=r.project_id and file_id=r.file_id and physical_page_number=page for share;
  if not found or p_review->>'pageSha256' is distinct from s.page_sha256 then raise exception 'Measurement physical page revision mismatch'; end if;
  width_:=case when s.rotation_degrees in (90,270) then s.height_points else s.width_points end;height_:=case when s.rotation_degrees in (90,270) then s.width_points else s.height_points end;
  result:=private.calculate_reviewed_measurement(p_review,width_,height_);
  select * into previous from public.takeoff_measurement_reviews where id=measurement_id for update;
  if found then
    if previous.takeoff_run_id<>r.id or previous.workspace_id<>p_workspace_id or previous.review_revision<>expected then raise exception 'Measurement review revision conflict'; end if;
    revision_:=previous.review_revision+1;
  else
    if expected<>0 then raise exception 'Measurement review revision conflict'; end if;
    revision_:=1;
  end if;
  insert into public.takeoff_measurement_reviews(id,takeoff_run_id,workspace_id,project_id,file_id,plan_sheet_id,file_sha256,physical_page_number,page_sha256,region_key,region_bounds,
    canonical_element_key,canonical_trade,label,geometry,geometry_fingerprint,source_kind,source_candidate_id,quantity,unit,calibration,proof,formula,method,uncertainty,review_status,review_revision,reviewed_by,reviewed_at)
  values(measurement_id,r.id,r.workspace_id,r.project_id,r.file_id,s.id,r.file_sha256,page,s.page_sha256,p_review->>'regionKey',p_review->'regionBounds',p_review->>'canonicalElementKey',p_review->>'canonicalTrade',btrim(p_review->>'label'),
    p_review->'geometry',private.measurement_geometry_fingerprint(p_review->'geometry'),p_review->>'sourceKind',p_review->>'sourceCandidateId',(result->>'quantity')::numeric,result->>'unit',result->'calibration',
    jsonb_build_object('version','measurement-review-v1','fileSha256',r.file_sha256,'pageSha256',s.page_sha256,'regionKey',p_review->>'regionKey','sourceExcerpt',p_review->>'sourceExcerpt',
      'geometryReviewed',p_review->'geometryReviewed','identityReviewed',p_review->'identityReviewed','duplicateReviewComplete',p_review->'duplicateReviewComplete','boundaryEvidence',p_review->'boundaryEvidence','calibrationEvidence',p_review->'calibrationEvidence','nativeCandidate',p_review->'nativeCandidate'),
    nullif(result->'formula','null'::jsonb),case when p_review->'geometry'->>'type' in ('point','count') then 'reviewed_visible_identity' else 'reviewed_geometry' end,p_review->'uncertainty',state,revision_,p_user_id,now())
  on conflict(id) do update set plan_sheet_id=excluded.plan_sheet_id,physical_page_number=excluded.physical_page_number,page_sha256=excluded.page_sha256,region_key=excluded.region_key,region_bounds=excluded.region_bounds,
    canonical_element_key=excluded.canonical_element_key,canonical_trade=excluded.canonical_trade,label=excluded.label,geometry=excluded.geometry,geometry_fingerprint=excluded.geometry_fingerprint,
    source_kind=excluded.source_kind,source_candidate_id=excluded.source_candidate_id,quantity=excluded.quantity,unit=excluded.unit,calibration=excluded.calibration,proof=excluded.proof,formula=excluded.formula,
    method=excluded.method,uncertainty=excluded.uncertainty,review_status=excluded.review_status,review_revision=excluded.review_revision,reviewed_by=excluded.reviewed_by,reviewed_at=now(),updated_at=now()
    where expected>0 and takeoff_measurement_reviews.review_revision=expected and takeoff_measurement_reviews.takeoff_run_id=r.id and takeoff_measurement_reviews.workspace_id=p_workspace_id returning * into saved;
  if not found then raise exception 'Measurement review revision conflict'; end if;
  insert into public.takeoff_measurement_review_events(measurement_id,workspace_id,project_id,reviewer_id,revision,snapshot)
    values(saved.id,saved.workspace_id,saved.project_id,p_user_id,saved.review_revision,to_jsonb(saved));
  return to_jsonb(saved);
end $$;

revoke all on function private.measurement_segments_cross(jsonb,jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function private.measurement_geometry_fingerprint(jsonb) from public,anon,authenticated,service_role;
revoke all on function private.measurement_is_native_extent(jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function private.calculate_reviewed_measurement(jsonb,numeric,numeric) from public,anon,authenticated,service_role;
revoke all on function public.record_takeoff_measurement_review(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_takeoff_measurement_review(uuid,uuid,uuid,jsonb) to service_role;
