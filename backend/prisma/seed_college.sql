INSERT INTO colleges (id, name, domain, email_format_pattern, is_active, created_at)
VALUES (
  gen_random_uuid()::text,
  'Dr B R Ambedkar National Institute of Technology Jalandhar',
  'nitj.ac.in',
  '^[a-zA-Z0-9._%+-]+@nitj\\.ac\\.in$',
  true,
  NOW()
)
ON CONFLICT (domain) DO UPDATE
SET
  name = EXCLUDED.name,
  email_format_pattern = EXCLUDED.email_format_pattern,
  is_active = EXCLUDED.is_active;
