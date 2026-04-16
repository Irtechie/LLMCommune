export function defaultDesiredState(nowIso = new Date().toISOString()) {
  return {
    mode: "idle",
    state: "idle",
    watchdog_enforce: false,
    lane_targets: {
      large: "",
      mini: "",
    },
    fleet_id: "",
    status_detail: "",
    updated_at: nowIso,
  };
}

export function watchdogEnabledForDesiredState(desiredState) {
  const state = String(desiredState?.state || "").toLowerCase();
  return Boolean(desiredState?.watchdog_enforce) && ["ready", "running"].includes(state);
}

/** LaneState FSM values — DARK is terminal until activate-set clears it. */
export const LaneState = Object.freeze({
  STARTING: "STARTING",
  READY: "READY",
  DEGRADED: "DEGRADED",
  CRASHED: "CRASHED",
  RECOVERING: "RECOVERING",
  DARK: "DARK",
});

/** 120 s grace period — watchdog does not act during lane startup. */
const STARTING_GRACE_MS = 120_000;

export function planWatchdogActions({ desiredState, currentState }) {
  if (!watchdogEnabledForDesiredState(desiredState)) {
    return [];
  }

  // STARTING grace: controller is mid-activation — never interfere.
  if (currentState?.activating) {
    return [];
  }

  if (desiredState.mode === "fleet" && desiredState.fleet_id) {
    if (!currentState?.mini_fleet?.up) {
      return [
        {
          key: `fleet:${desiredState.fleet_id}`,
          label: `fleet ${desiredState.fleet_id}`,
          pathName: "/fleet/up",
          payload: {},
        },
      ];
    }
    return [];
  }

  const actions = [];
  const darkStates = desiredState.lane_dark_states || {};
  const largeTarget = String(desiredState?.lane_targets?.large || "").trim();
  const miniTarget = String(desiredState?.lane_targets?.mini || "").trim();
  const largeCurrent = currentState?.lanes?.large || {};
  const miniCurrent = currentState?.lanes?.mini || {};

  // Large lane — skip if explicitly DARK
  if (largeTarget && !darkStates.large) {
    const laneState = _classifyLane(largeCurrent, largeTarget);
    if (laneState !== LaneState.READY && laneState !== LaneState.STARTING && laneState !== LaneState.DARK) {
      actions.push({
        key: `lane:large:${largeTarget}`,
        label: `restore large lane ${largeTarget} (state:${laneState})`,
        pathName: "/api/llm-host/activate",
        payload: {
          profile_id: largeTarget,
          lane_id: "large",
          wait: false,
          allow_preempt: true,
        },
      });
    }
  }

  // Mini lane — skip if explicitly DARK
  if (miniTarget && !darkStates.mini) {
    const laneState = _classifyLane(miniCurrent, miniTarget);
    if (laneState !== LaneState.READY && laneState !== LaneState.STARTING && laneState !== LaneState.DARK) {
      actions.push({
        key: `lane:mini:${miniTarget}`,
        label: `restore mini lane ${miniTarget} (state:${laneState})`,
        pathName: "/api/llm-host/activate",
        payload: {
          profile_id: miniTarget,
          lane_id: "mini",
          wait: false,
          allow_preempt: true,
        },
      });
    }
  }

  return actions;
}

/**
 * Classify a lane into a LaneState based on live currentState.
 * @param {object} lanePayload - currentState.lanes.large or .mini
 * @param {string} targetProfileId
 * @returns {LaneState}
 */
function _classifyLane(lanePayload, targetProfileId) {
  if (!lanePayload || !lanePayload.up) {
    // Down but recently started → STARTING grace
    const startedMs = lanePayload?.started_at_ms ?? 0;
    if (startedMs && Date.now() - startedMs < STARTING_GRACE_MS) {
      return LaneState.STARTING;
    }
    return LaneState.CRASHED;
  }
  if (String(lanePayload.profile_id || "") === targetProfileId) {
    // up=true, profile matches, but model may still be loading (/v1/models not yet serving)
    if (lanePayload.ready === false) {
      return LaneState.STARTING;
    }
    return LaneState.READY;
  }
  // Up but wrong profile → needs replacement
  return LaneState.DEGRADED;
}
