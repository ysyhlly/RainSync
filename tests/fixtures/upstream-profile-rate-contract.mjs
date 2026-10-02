// Test-side oracle for the versioned contract. A discrete set is never a ceiling.
import assert from "node:assert/strict";

export const embySampleRates = Object.freeze([44100, 48000]);
export const profileVersion = (kind) => kind === "emby" ? 2 : 1;
export const profileId = (kind) => kind === "emby" ? "emby_avc_sdr_720p_rates_v2" : "avc_sdr_720p_v1";

export function positiveRateReports(profile) {
  if (profile.profile_version === 1) return {};
  assert.equal(profile.profile_version, 2);
  return { audio_rate_reports: (profile.audio_rate_contract?.allowed_sample_rates ?? []).map((sample_rate) => ({
    sample_rate, mse_supported: true,
    mse_decoding: { supported: true, smooth: false, power_efficient: false },
  })) };
}

export function assertAudioRateContract(profile, kind, sourceRate) {
  assert.equal(profile.profile_version, profileVersion(kind));
  assert.equal(profile.profile_id, profileId(kind));
  if (profile.requested_audio === null) {
    assert.equal(profile.mse_sample.audio, null);
    assert.equal(profile.audio_rate_contract, undefined);
    return;
  }
  assert.equal(profile.requested_audio.requested_sample_rate, 48000,
    "the existing requested rate is not replaced by an output claim");
  assert.equal(profile.mse_sample.audio.samplerate, 48000);
  if (kind === "jellyfin") {
    assert.equal(profile.audio_rate_contract, undefined, "Jellyfin v1 wire shape stays unchanged");
    return;
  }
  assert.ok(embySampleRates.includes(sourceRate), "Emby has a known source rate in the discrete set");
  assert.deepEqual(profile.audio_rate_contract, {
    allowed_sample_rates: [...embySampleRates], source_sample_rate: sourceRate,
    mse_samples: embySampleRates.map((samplerate) => ({ ...profile.mse_sample.audio, samplerate })),
  }, "Emby binds the exact canonical dual-rate set and both MSE configurations");
}

export function assertObservedAudioRate(kind, sampleRate) {
  assert.ok(Number.isInteger(sampleRate), "observed output rate is an integer");
  if (kind === "emby")
    assert.ok(embySampleRates.includes(sampleRate), "observed Emby output is a member of {44100,48000}, not any lower rate");
  else {
    assert.equal(kind, "jellyfin");
    assert.equal(sampleRate, 48000, "observed Jellyfin output remains exactly 48000");
  }
}
