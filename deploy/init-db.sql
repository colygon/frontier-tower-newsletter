-- Create databases for each service
-- (Platform, Twenty CRM, Hi.Events share one Postgres instance)

CREATE DATABASE twenty;
CREATE DATABASE hievents;

-- Grant access
GRANT ALL PRIVILEGES ON DATABASE twenty TO eventsy;
GRANT ALL PRIVILEGES ON DATABASE hievents TO eventsy;
