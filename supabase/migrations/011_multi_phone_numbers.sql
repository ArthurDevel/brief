-- Multi phone number support: company phone numbers table + migrate user phone
-- data from text column to JSONB.
--
-- Steps:
--   1. Create company_phone_numbers table with environment-aware unique constraint
--   2. Seed US and Belgian prod numbers
--   3. Enable RLS with SELECT policy for authenticated users
--   4. Add phone JSONB column to user_settings
--   5. Migrate existing phone_number text values to phone JSONB (assume US)
--   6. Drop old phone_number column
--   7. Drop old idx_user_settings_phone index
--   8. Create unique functional index on phone->>'number'


-- ============================================================================
-- 1. CREATE COMPANY_PHONE_NUMBERS TABLE
-- ============================================================================

create table company_phone_numbers (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null unique,
  label text not null,
  country_code text not null,
  environment text not null default 'prod'
    check (environment in ('dev', 'prod')),
  is_active boolean not null default true,
  created_at timestamptz default now(),

  -- One number per country per environment
  constraint company_phone_numbers_country_env_unique unique (country_code, environment)
);


-- ============================================================================
-- 2. SEED DATA
-- ============================================================================

insert into company_phone_numbers (phone_number, label, country_code, environment, is_active)
values
  ('+19254034211', 'United States', 'US', 'prod', true),
  ('+32460256769', 'Belgium', 'BE', 'prod', true),
  ('+16509774723', 'United States', 'US', 'dev', true);


-- ============================================================================
-- 3. RLS: AUTHENTICATED USERS CAN READ COMPANY PHONE NUMBERS
-- ============================================================================

alter table company_phone_numbers enable row level security;

create policy "Authenticated users can read company phone numbers"
  on company_phone_numbers
  for select
  to authenticated
  using (true);


-- ============================================================================
-- 4. ADD PHONE JSONB COLUMN TO USER_SETTINGS
-- ============================================================================

alter table user_settings
  add column phone jsonb default null;


-- ============================================================================
-- 5. MIGRATE EXISTING PHONE_NUMBER DATA TO PHONE JSONB (ASSUME US)
-- ============================================================================

update user_settings
set phone = jsonb_build_object('number', phone_number, 'countryCode', 'US')
where phone_number is not null;


-- ============================================================================
-- 6. DROP OLD PHONE_NUMBER COLUMN
-- ============================================================================

alter table user_settings
  drop column phone_number;


-- ============================================================================
-- 7. DROP OLD INDEX
-- ============================================================================

drop index if exists idx_user_settings_phone;


-- ============================================================================
-- 8. CREATE UNIQUE FUNCTIONAL INDEX ON PHONE NUMBER
-- ============================================================================

create unique index idx_user_settings_phone_number
  on user_settings ((phone->>'number'));
