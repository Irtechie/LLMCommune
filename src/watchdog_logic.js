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

function swapAllowsAction(currentState, actionName) {
  const swap = currentState?.swap;
  if (!swap) return true;
  const policyState = String(swap?.action_policy_state || "").trim().toLowerCase();
  const reconcileNeeded = Boolean(
    swap?.reconcile_needed || String(swap?.swap_terminal_state || "").trim().toLowerCase() === "reconcile_needed",
  );
  if (!reconcileNeeded && (!policyState || policyState === "normal")) {
    return true;
  }
  const blockedActions = new Set(
    (Array.isArray(swap?.blocked_actions) ? swap.blocked_actions : [])
      .map((entry) => typeof entry === "string" ? entry : entry?.action)
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean),
  );
  if (blockedActions.has(actionName)) {
    return false;
  }
  const allowedActions = new Set(
    (Array.isArray(swap?.allowed_actions) ? swap.allowed_actions : [])
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean),
  );
  if (allowedActions.size > 0) {
    return allowedActions.has(actionName);
  }
  return false;
}

export function planWatchdogActions({ desiredState, currentState }) {
  if (!watchdogEnabledForDesiredState(desiredState)) {
    return [];
  }

  // STARTING grace: controller is mid-activation — never interfere.
  if (currentState?.activating) {
    return [];
  }

  if (desiredState.mode === "fleet" && desiredState.fleet_id) {
    if (!currentState?.mini_fleet?.up && swapAllowsAction(currentState, "fleet_up")) {
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
  const desiredSetId = String(desiredState?.active_set_id || "").trim();
  const largeTarget = String(desiredState?.lane_targets?.large || "").trim();
  const miniTarget = String(desiredState?.lane_targets?.mini || "").trim();
  const largeCurrent = currentState?.lanes?.large || {};
  const miniCurrent = currentState?.lanes?.mini || {};
  const largeState = largeTarget ? _classifyLane(largeCurrent, largeTarget) : LaneState.READY;
  const miniState = miniTarget ? _classifyLane(miniCurrent, miniTarget) : LaneState.READY;
  const largeNeedsRestore = Boolean(largeTarget) && !darkStates.large
    && largeState !== LaneState.READY
    && largeState !== LaneState.STARTING
    && largeState !== LaneState.DARK;
  const miniNeedsRestore = Boolean(miniTarget) && !darkStates.mini
    && miniState !== LaneState.READY
    && miniState !== LaneState.STARTING
    && miniState !== LaneState.DARK;
  const canRestoreSet = Boolean(desiredSetId)
    && !(largeTarget && darkStates.large)
    && !(miniTarget && darkStates.mini);

  if (canRestoreSet && (largeNeedsRestore || miniNeedsRestore) && swapAllowsAction(currentState, "activate_set")) {
    return [
      {
        key: `set:${desiredSetId}`,
        label: `activation set ${desiredSetId}`,
        pathName: "/api/llm-host/activate-set",
        payload: {
          set_id: desiredSetId,
          wait: false,
          allow_preempt: true,
        },
      },
    ];
  }

  if (largeNeedsRestore && swapAllowsAction(currentState, "activate")) {
    actions.push({
      key: `lane:large:${largeTarget}`,
      label: `restore large lane ${largeTarget} (state:${largeState})`,
      pathName: "/api/llm-host/activate",
      payload: {
        profile_id: largeTarget,
        lane_id: "large",
        wait: false,
        allow_preempt: true,
      },
    });
  }

  if (miniNeedsRestore && swapAllowsAction(currentState, "activate")) {
    actions.push({
      key: `lane:mini:${miniTarget}`,
      label: `restore mini lane ${miniTarget} (state:${miniState})`,
      pathName: "/api/llm-host/activate",
      payload: {
        profile_id: miniTarget,
        lane_id: "mini",
        wait: false,
        allow_preempt: true,
      },
    });
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
