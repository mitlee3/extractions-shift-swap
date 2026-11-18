--------------------------------------------------------------------------------
-- 1. USERS TABLE
--------------------------------------------------------------------------------
CREATE TABLE "User" (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    shift_number VARCHAR(1), 
    position VARCHAR(4) CHECK (
        position IN ('CLA', 'CLS', 'CORE')
        ),    
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

--------------------------------------------------------------------------------
-- 4. USER SCHEDULE HISTORY
-- Stores every recurring schedule version an employee has had.
--------------------------------------------------------------------------------
CREATE TABLE "UserScheduleHistory" (
    schedule_id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (schedule_id, user_id)
);

--------------------------------------------------------------------------------
-- 2. USER SCHEDULE DAYS
-- Stores the actual weekdays belonging to each schedule version.
--------------------------------------------------------------------------------

CREATE TABLE "UserScheduleDays" (
    schedule_id INT NOT NULL REFERENCES "UserScheduleHistory"(schedule_id)   ON DELETE RESTRICT,
    day_of_week SMALLINT NOT NULL
        CHECK (day_of_week BETWEEN 0 AND 6),
    PRIMARY KEY (schedule_id, day_of_week)
);
--------------------------------------------------------------------------------
-- 3. USER SCHEDULE CURRENT
-- Stores the employee's currently active schedule version.
--------------------------------------------------------------------------------

CREATE TABLE "UserScheduleCurrent" (
    user_id UUID PRIMARY KEY    REFERENCES "User"(id) ON DELETE CASCADE,
    schedule_id INT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (schedule_id, user_id)  REFERENCES "UserScheduleHistory"(schedule_id, user_id) ON DELETE RESTRICT
);


--------------------------------------------------------------------------------
-- 5. SHIFT SWAPS OPEN
--------------------------------------------------------------------------------
CREATE TABLE "ShiftSwapsOpen" (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    person_requesting UUID NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
    requester_schedule_id INTEGER NOT NULL REFERENCES "UserScheduleHistory"(schedule_id) ON DELETE RESTRICT,
    person_requesting_on DATE NOT NULL,                           
    request_opened_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (requester_schedule_id, person_requesting)
        REFERENCES "UserScheduleHistory"(schedule_id, user_id)
        ON DELETE RESTRICT
);

--------------------------------------------------------------------------------
-- 6. SHIFT SWAP OFFERS
--------------------------------------------------------------------------------
CREATE TABLE "ShiftOffers" (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    corresponding_request_id INTEGER NOT NULL   REFERENCES "ShiftSwapsOpen"(id) ON DELETE CASCADE,
    person_offering UUID NOT NULL   REFERENCES "User"(id) ON DELETE RESTRICT,
    offering_schedule_id INTEGER NOT NULL,
    person_offering_on DATE NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(20) NOT NULL DEFAULT 'Active'
        CHECK (
            status IN (
                'Active',
                'Selected',
                'Offer Withdrawn',
                'Expired'
            )
        ),

    FOREIGN KEY (offering_schedule_id, person_offering)
        REFERENCES "UserScheduleHistory"(schedule_id, user_id)
        ON DELETE RESTRICT,

    UNIQUE (corresponding_request_id, person_offering)
);


--------------------------------------------------------------------------------
-- 7. SHIFT SWAP HISTORY
--------------------------------------------------------------------------------
CREATE TABLE "ShiftSwapsHistory" (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    person_requesting UUID NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
    person_offering UUID NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
    requester_schedule_id INTEGER NOT NULL ON DELETE RESTRICT,
    offering_schedule_id INTEGER NOT NULL ON DELETE RESTRICT,
    person_requesting_on DATE NOT NULL,
    person_offering_on DATE NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(25) NOT NULL DEFAULT 'Submitted Pending'
        CHECK (
            status IN (
                'Submitted Pending',
                'Accepted By Core',
                'Denied By Core',
                'Cancelled',
                'Expired'
            )
        ),
    status_timestamp TIMESTAMPTZ,
    CHECK (person_requesting <> person_offering)

    FOREIGN KEY (requester_schedule_id, person_requesting)
        REFERENCES "UserScheduleHistory"(schedule_id, user_id)
        ON DELETE RESTRICT,

    FOREIGN KEY (offering_schedule_id, person_offering)
        REFERENCES "UserScheduleHistory"(schedule_id, user_id)
        ON DELETE RESTRICT
);

--------------------------------------------------------------------------------
-- 8. SCHEDULE EXCEPTIONS
-- Used for implementing recurrance with exceptions method of making sure shfit swaps aren't 7 days in a row
--------------------------------------------------------------------------------
CREATE TABLE "ScheduleExceptions" (
    id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
    exception_date DATE NOT NULL,
    is_working BOOLEAN NOT NULL,
    shift_swap_id INT REFERENCES "ShiftSwapsHistory"(id) ON DELETE RESTRICT,
    UNIQUE (user_id, exception_date)
);



--------------------------------------------------------------------------------
-- Indicies to make searching more computationally efficient
--------------------------------------------------------------------------------
-- For: retrieving previous schedules for employee, when a employee changed schedules
CREATE INDEX idx_schedule_history_user ON "UserScheduleHistory"(user_id);

-- For: displaying active offers
CREATE INDEX idx_shift_offers_active ON "ShiftOffers"(corresponding_request_id) WHERE status = 'Active';

