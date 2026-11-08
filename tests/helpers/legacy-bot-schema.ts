/** Test-fixture reconstruction only. These statements are never a production
 * rollback: pre-v81/pre-v80 fixtures cannot retain newer tables/triggers that
 * refer to the older tables/columns being reconstructed. */
export const DROP_GROUP_DISCUSSION_FIXTURE_SCHEMA = `
  DROP TABLE IF EXISTS bot_group_discussion_work;
  DROP TABLE IF EXISTS bot_group_discussion_turns;
  DROP TABLE IF EXISTS bot_group_discussions;
  DROP TABLE IF EXISTS bot_group_dot_sessions;
  DROP TABLE IF EXISTS bot_group_discussion_settings;
`;
export const DROP_V81_BOT_FIXTURE_SCHEMA =
  DROP_GROUP_DISCUSSION_FIXTURE_SCHEMA +
  `
  DROP TABLE IF EXISTS bot_group_feedback_exports;
  DROP TABLE IF EXISTS bot_group_feedback_requests;
  DROP TABLE IF EXISTS bot_group_message_feedback;
  DROP TABLE IF EXISTS cloud_device_wakes;
  DROP TABLE IF EXISTS cloud_device_requests;
  DROP TABLE IF EXISTS cloud_device_grant_origins;
  DROP TABLE IF EXISTS personal_goal_team_steps;
  DROP TABLE IF EXISTS personal_goal_teams;
  DROP TABLE IF EXISTS bot_handoff_associations;
  DROP TABLE IF EXISTS bot_handoff_session_origins;
  DROP TABLE IF EXISTS bot_group_handoffs;
  DROP TABLE IF EXISTS bot_group_runtime_grants;
  DROP TABLE IF EXISTS product_input_task_sources;
`;
export const DROP_V80_BOT_FIXTURE_SCHEMA =
  DROP_GROUP_DISCUSSION_FIXTURE_SCHEMA +
  `
  DROP TABLE IF EXISTS bot_group_receipts;
  DROP TABLE IF EXISTS bot_group_messages;
  DROP TABLE IF EXISTS bot_group_members;
  DROP TABLE IF EXISTS bot_groups;
`;
