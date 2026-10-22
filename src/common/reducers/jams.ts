import { actions } from "common/actions";
import reducer from "common/reducers/reducer";
import { emptyJamsState, JamsState } from "common/jams/state";

export default reducer<JamsState>(emptyJamsState(), (on) => {
  on(actions.jamsReplace, (_state, action) => action.payload.state);
  on(actions.loggedOut, () => emptyJamsState());
  on(actions.loginSucceeded, () => emptyJamsState());
  on(actions.jamEntryPatch, (state, { payload }) => {
    const jam = state.workspaces[payload.jamId];
    if (state.profileId !== payload.profileId || !jam) return state;
    return {
      ...state,
      workspaces: {
        ...state.workspaces,
        [jam.id]: {
          ...jam,
          progress: {
            ...jam.progress,
            [payload.submissionId]: {
              ...(jam.progress[payload.submissionId] || {
                status: "new" as const,
              }),
              ...payload.patch,
            },
          },
        },
      },
    };
  });
});
