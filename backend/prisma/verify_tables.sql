SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'colleges',
    'users',
    'sessions',
    'messages',
    'reports',
    'bans'
  )
ORDER BY table_name;
