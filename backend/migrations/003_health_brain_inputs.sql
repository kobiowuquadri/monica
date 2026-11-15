-- Inputs for the Health Brain index (RHI): an optional radiation dose-rate reading and an
-- optional lymphocyte count per check-in. Both are nullable: absent means "not assessed".
ALTER TABLE check_ins
  ADD COLUMN exposure_dose_rate   numeric(9,3) CHECK (exposure_dose_rate IS NULL OR (exposure_dose_rate >= 0 AND exposure_dose_rate <= 100000)),
  ADD COLUMN exposure_unit        text CHECK (exposure_unit IS NULL OR exposure_unit = 'microGray / Hour'),
  -- 'nasa_replay' marks demo scenarios that replay archived NASA MSL RAD measurements; it can
  -- only be written by the demo seeder, never through the check-in API.
  ADD COLUMN exposure_source_type text CHECK (exposure_source_type IS NULL OR exposure_source_type IN ('manual','device_reported','nasa_replay')),
  ADD COLUMN exposure_source_note text,
  ADD COLUMN lymphocyte_count     numeric(5,2) CHECK (lymphocyte_count IS NULL OR (lymphocyte_count >= 0 AND lymphocyte_count <= 20)),
  ADD CONSTRAINT check_ins_exposure_complete CHECK ((exposure_dose_rate IS NULL) = (exposure_source_type IS NULL));
