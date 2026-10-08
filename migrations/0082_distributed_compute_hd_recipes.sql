-- Extend only the fixed recipe allowlists. Existing policies, capabilities,
-- output limits, authority bindings and published migration bytes are unchanged.
ALTER TABLE distributed_compute_nodes
 DROP CONSTRAINT distributed_compute_nodes_capabilities_check,
 ADD CONSTRAINT distributed_compute_nodes_capabilities_check
 CHECK(capabilities <@ ARRAY[
  'remux_hls_v1','h264_480p_hls_v1','h264_720p_hls_v1',
  'h264_1080p_hls_v1','h264_2160p_hls_v1'
 ]::text[]);
ALTER TABLE distributed_compute_jobs
 DROP CONSTRAINT distributed_compute_jobs_recipe_check,
 ADD CONSTRAINT distributed_compute_jobs_recipe_check
 CHECK(recipe IN (
  'remux_hls_v1','h264_480p_hls_v1','h264_720p_hls_v1',
  'h264_1080p_hls_v1','h264_2160p_hls_v1'
 ));
