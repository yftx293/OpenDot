// Build-time rollback of the default entry/navigation; no data migration.
export const BOT_FIRST_HOME_ENABLED =
  import.meta.env.VITE_BOT_FIRST_HOME !== 'false';
