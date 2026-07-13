Archived Mon Jul 13 2026: Hub Web dead route pages TasksPage and MergePage.

What was removed:
- web/src/pages/TasksPage.tsx — task list UI (Pilot/SOTAgent tabs); never imported or mounted in App.tsx routes.
- web/src/pages/MergePage.tsx — branch merge UI; never imported or mounted in App.tsx routes.

Why removed:
- Dead code: components existed but had no Route in web/src/App.tsx and no nav links in Layout. Functionality superseded by Dashboard/Pilot pages or unused merge UI.

How to restore:
1. Copy TasksPage.tsx and MergePage.tsx from this directory back to web/src/pages/.
2. In web/src/App.tsx, add imports and Route entries, e.g.:
   - import { TasksPage } from './pages/TasksPage'
   - import { MergePage } from './pages/MergePage'
   - <Route path="/tasks" element={<TasksPage />} />
   - <Route path="/merge" element={<MergePage />} />
3. Add sidebar/nav links in Layout if needed.
4. Run `npm run build` in web/.

Original paths:
- web/src/pages/TasksPage.tsx
- web/src/pages/MergePage.tsx
