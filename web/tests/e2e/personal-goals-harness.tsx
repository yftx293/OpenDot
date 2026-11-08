import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { GoalsPage } from '../../src/pages/GoalsPage';
import { useAuthStore } from '../../src/stores/auth';
import { useGroupsStore } from '../../src/stores/groups';
import '../../src/styles/globals.css';
import '../../src/styles/product.css';

useAuthStore.setState({
  user: {
    id: 'alice',
    username: 'alice',
    display_name: 'Alice',
    role: 'member',
  } as NonNullable<ReturnType<typeof useAuthStore.getState>['user']>,
});
useGroupsStore.setState({
  groups: {
    'web:project': {
      name: '研究项目',
      folder: 'project',
      added_at: '2026-10-16T00:00:00Z',
      interaction_mode: 'assistant',
      created_by: 'alice',
    },
  },
  loadGroups: async () => {},
});
createRoot(document.getElementById('root')!).render(
  <MemoryRouter>
    <GoalsPage />
  </MemoryRouter>,
);
