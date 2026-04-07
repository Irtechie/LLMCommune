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

export function planWatchdogActions({ desiredState, currentState }) {
  if (!watchdogEnabledForDesiredState(desiredState)) {
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
  const largeTarget = String(desiredState?.lane_targets?.large || "").trim();
  const miniTarget = String(desiredState?.lane_targets?.mini || "").trim();
  const largeCurrent = currentState?.lanes?.large || {};
  const miniCurrent = currentState?.lanes?.mini || {};

  if (largeTarget && (!largeCurrent.up || String(largeCurrent.profile_id || "") !== largeTarget)) {
    actions.push({
      key: `lane:large:${largeTarget}`,
      label: `restore large lane ${largeTarget}`,
      pathName: "/api/llm-host/activate",
      payload: {
        profile_id: largeTarget,
        lane_id: "large",
        wait: false,
        allow_preempt: true,
      },
    });
  }

  if (miniTarget && (!miniCurrent.up || String(miniCurrent.profile_id || "") !== miniTarget)) {
    actions.push({
      key: `lane:mini:${miniTarget}`,
      label: `restore mini lane ${miniTarget}`,
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
