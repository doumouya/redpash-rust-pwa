-- The Home (launcher/overview) page was removed — redpash-next is reconsidering
-- what's worth keeping, and a separate launcher hub wasn't. Its two preference
-- fields are now dead: home.show_recents (the Home "Show recent files" toggle)
-- and app.home.enabled (the platform app-visibility policy for the Home app).
-- Drop them from the `preference` type so Settings no longer renders a "Home"
-- pref group and the Console no longer lists a "Home" app policy, and remove any
-- stored values (DELETE of absent keys is a harmless no-op).
DELETE FROM type_fields
 WHERE type_id = 'preference'
   AND field IN ('home.show_recents', 'app.home.enabled');

DELETE FROM settings
 WHERE key IN ('home.show_recents', 'app.home.enabled');
