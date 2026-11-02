// Copied verbatim from ops/analytics/analytics-config.mjs (Analytics owner): the privacy gates, options and event allowlist.
// Change it there first, then copy it here.
// Integration module for the UI owner. Pin posthog-js 1.444.4 or re-verify these options on upgrade.
// No SDK import or key here: self-hosted builds are OFF by default.
export const HOSTED_EVENTS = Object.freeze([
  'landing_viewed', 'signup_completed', 'parental_consent_completed', 'subscription_started',
  'writer_created', 'story_started', 'page_formed', 'picture_ready', 'read_aloud_started',
  'story_shared', 'app_error', 'rage_click', 'page_performance', 'operation_completed',
]);
const enums = {
  surface: ['parent', 'kid'],
  route: ['/', '/signup', '/consent', '/pricing', '/checkout', '/account', '/writers', '/write', '/read'],
  operation: ['signup', 'consent', 'subscribe', 'writer', 'story', 'page', 'image', 'audio', 'share', 'stt', 'save'],
  control: ['signup', 'consent', 'subscribe', 'writer', 'story', 'page', 'image', 'audio', 'share', 'record', 'save', 'next', 'back'],
  error_code: ['network', 'timeout', 'rate_limit', 'quota', 'provider', 'validation', 'unauthorized', 'unknown'],
};
const numeric = new Set(['duration_ms', 'lcp_ms', 'inp_ms', 'cls', 'status']);
const opaque = new Set(['account_id', 'story_id']);
export function safeProperties(input = {}) {
  const out = { schema_version: 1 };
  for (const [k, v] of Object.entries(input)) {
    if (enums[k]?.includes(v)) out[k] = v;
    else if (numeric.has(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
    else if (opaque.has(k) && typeof v === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(v)) out[k] = v;
    else if (k === 'ok' && typeof v === 'boolean') out[k] = v;
  }
  return out;
}

export function analyticsConfig({ mode = 'self', key = '', analyticsConsent = false,
  parentalConsent = false, surface = 'parent', publicReader = false,
  budgetVerified = false, replayApproved = false, ownKey = false } = {}) {
  if (typeof key !== 'string' || !key.startsWith('phc_') || !analyticsConsent || publicReader ||
      !['self', 'hosted'].includes(mode) || !['parent', 'kid'].includes(surface) ||
      (surface === 'kid' && !parentalConsent) ||
      (mode === 'self' && !ownKey) || (mode === 'hosted' && !budgetVerified)) return null;
  return {
    api_host: 'https://us.i.posthog.com', ui_host: 'https://us.posthog.com',
    persistence: 'localStorage', cross_subdomain_cookie: false,
    person_profiles: 'identified_only', ip: false,
    autocapture: false, rageclick: false, capture_pageview: false, capture_pageleave: false,
    capture_exceptions: false, capture_performance: false,
    enable_recording_console_log: false, disable_session_recording: !replayApproved,
    disable_surveys: true, disable_surveys_automatic_display: true,
    enable_heatmaps: false, capture_dead_clicks: false,
    session_recording: {
      maskAllInputs: true, maskTextSelector: '*', maskTextFn: () => '***',
      maskInputFn: () => '***', maskAllElementAttributes: true,
      blockSelector: '.ph-no-capture, .ph-sensitive-media, input[type="hidden"], input[type="file"], .kid-screen img, .kid-screen svg, canvas, video, audio, iframe',
      recordHeaders: false, recordBody: false, recordCrossOriginIframes: false,
      canvasCapture: { maskRegionsFn: () => null },
      captureCanvas: { recordCanvas: false },
      captureJsonLd: false, collectFonts: false, inlineStylesheet: false,
      maskCapturedNetworkRequestFn: () => null, sampleRate: 0.1,
    },
    before_send(event) {
      // Snapshot payloads use the recorder's masking; automatic product events are rejected.
      if (!HOSTED_EVENTS.includes(event.event) && event.event !== '$identify') return null;
      const source = event.properties || {};
      const props = { ...safeProperties(source), app_mode: mode, surface, $geoip_disable: true, $ip: '0.0.0.0' };
      for (const k of ['token', 'distinct_id', '$anon_distinct_id', '$device_id', '$session_id', '$window_id', '$insert_id', '$lib', '$lib_version']) {
        if (typeof source[k] === 'string') props[k] = source[k];
      }
      return { ...event, properties: props, $set: undefined, $set_once: undefined, $unset: undefined };
    },
  };
}

export function captureSafe(posthog, event, properties = {}) {
  if (HOSTED_EVENTS.includes(event)) posthog?.capture(event, safeProperties(properties));
}

export function withdrawAnalytics(posthog) {
  posthog?.stopSessionRecording();
  posthog?.opt_out_capturing({ clear_persistence: true });
  posthog?.reset();
}
