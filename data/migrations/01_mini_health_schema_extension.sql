-- ==============================================================================
-- MiniHealth Schema 增补迁移脚本 (01_mini_health_schema_extension.sql)
-- 增量扩展现有 mini_health Schema (保留已有的 care_services, patient_situations 等表)
-- ==============================================================================

-- 确保 Schema 存在
CREATE SCHEMA IF NOT EXISTS mini_health;

-- 1. 主账号表 (基于微信 OpenID 或客户端 ID 的主用户)
CREATE TABLE IF NOT EXISTS mini_health.users (
    id VARCHAR(64) PRIMARY KEY,
    phone VARCHAR(20),
    unionid VARCHAR(64),
    nickname VARCHAR(100),
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. 家庭成员档案表 (一人管理全家，关联已有的 patient_situations)
CREATE TABLE IF NOT EXISTS mini_health.members (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL REFERENCES mini_health.users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    relation VARCHAR(32) NOT NULL DEFAULT 'self',
    gender VARCHAR(10),
    age INTEGER,
    height_cm NUMERIC(5, 2),
    weight_kg NUMERIC(5, 2),
    medical_history JSONB NOT NULL DEFAULT '[]'::jsonb,
    allergies JSONB NOT NULL DEFAULT '[]'::jsonb,
    current_situation_id TEXT REFERENCES mini_health.patient_situations(id) ON DELETE SET NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_members_user ON mini_health.members(user_id);
CREATE INDEX IF NOT EXISTS idx_members_active ON mini_health.members(is_active);

-- 3. 对话消息持久化表 (对齐 wechat_archiver.messages，支持最近 20 条回查)
CREATE TABLE IF NOT EXISTS mini_health.messages (
    id VARCHAR(64) PRIMARY KEY,
    member_id VARCHAR(64) NOT NULL REFERENCES mini_health.members(id) ON DELETE CASCADE,
    direction VARCHAR(16) NOT NULL,
    msgtype VARCHAR(32) NOT NULL,
    content TEXT NOT NULL,
    media_url TEXT,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    msg_time TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mini_messages_member ON mini_health.messages(member_id, msg_time DESC);

-- 4. 结构化日常打卡与代谢流水表 (饮食代谢、血压、血糖等)
CREATE TABLE IF NOT EXISTS mini_health.records (
    id VARCHAR(64) PRIMARY KEY,
    member_id VARCHAR(64) NOT NULL REFERENCES mini_health.members(id) ON DELETE CASCADE,
    record_type VARCHAR(32) NOT NULL,
    record_date DATE NOT NULL DEFAULT CURRENT_DATE,
    metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_msg_id VARCHAR(64) REFERENCES mini_health.messages(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mini_records_member_date ON mini_health.records(member_id, record_date);
CREATE INDEX IF NOT EXISTS idx_mini_records_type ON mini_health.records(record_type);
