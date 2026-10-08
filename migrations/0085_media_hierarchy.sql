-- Browse indexes contain only safe source-relative directory names or explicit
-- upstream series/season identities. Never derive folders from host paths/URLs.
CREATE FUNCTION media_browse_parts(kind text, resource text, metadata jsonb)
RETURNS TABLE(path text[], labels text[]) LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE parts text[]; part text; series text; season text; season_number text;
BEGIN
  path := ARRAY[]::text[];
  labels := ARRAY[]::text[];
  IF kind IN ('local','agent','s3') THEN
    IF resource IS NULL OR octet_length(resource)>4096 OR resource ~ '[[:cntrl:]]'
       OR resource ~ '^[\\/]' OR resource ~ '^[A-Za-z][A-Za-z0-9+.-]*:' THEN
      RETURN NEXT; RETURN;
    END IF;
    parts := string_to_array(replace(resource, E'\\', '/'), '/');
    IF cardinality(parts)>64 OR cardinality(parts)=0 THEN RETURN NEXT; RETURN; END IF;
    FOREACH part IN ARRAY parts LOOP
      IF part IN ('','.','..') OR length(part)>255 THEN RETURN NEXT; RETURN; END IF;
    END LOOP;
    path := parts[1:greatest(cardinality(parts)-1,0)];
    labels := path;
  ELSIF kind IN ('jellyfin','emby') AND metadata->>'Type'='Episode' THEN
    series := metadata->>'SeriesId';
    IF series IS NULL OR series !~ '^[A-Za-z0-9_-]{1,128}$' THEN RETURN NEXT; RETURN; END IF;
    path := ARRAY['series:'||series];
    labels := ARRAY[CASE WHEN length(trim(metadata->>'SeriesName')) BETWEEN 1 AND 200
      AND metadata->>'SeriesName' !~ '[[:cntrl:]]' THEN trim(metadata->>'SeriesName') ELSE '未命名剧集' END];
    season := metadata->>'SeasonId';
    season_number := metadata->>'ParentIndexNumber';
    IF season_number IS NOT NULL AND season_number !~ '^[0-9]{1,5}$' THEN season_number := NULL; END IF;
    IF season ~ '^[A-Za-z0-9_-]{1,128}$' THEN
      path := path || ('season:'||season);
    ELSIF season_number IS NOT NULL THEN
      path := path || ('number:'||season_number);
    ELSE
      RETURN NEXT; RETURN;
    END IF;
    labels := labels || CASE WHEN length(trim(metadata->>'SeasonName')) BETWEEN 1 AND 200
      AND metadata->>'SeasonName' !~ '[[:cntrl:]]' THEN trim(metadata->>'SeasonName')
      WHEN season_number IS NOT NULL THEN '第 '||season_number||' 季' ELSE '未命名季' END;
  END IF;
  RETURN NEXT;
END $$;

ALTER TABLE media_items ADD COLUMN browse_path text[] NOT NULL DEFAULT ARRAY[]::text[];
ALTER TABLE media_items ADD COLUMN browse_labels text[] NOT NULL DEFAULT ARRAY[]::text[];
CREATE FUNCTION update_media_browse_parts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_kind text;
BEGIN
  SELECT kind INTO source_kind FROM sources WHERE id=NEW.source_id;
  SELECT path, labels INTO NEW.browse_path, NEW.browse_labels
    FROM media_browse_parts(source_kind, NEW.resource, NEW.metadata);
  RETURN NEW;
END $$;
CREATE TRIGGER media_browse_parts_update BEFORE INSERT OR UPDATE OF source_id,resource,metadata
  ON media_items FOR EACH ROW EXECUTE FUNCTION update_media_browse_parts();
UPDATE media_items SET resource=resource;
CREATE INDEX media_browse_source ON media_items(source_id,id) WHERE available;
CREATE INDEX media_browse_components ON media_items USING gin(browse_path) WHERE available;
