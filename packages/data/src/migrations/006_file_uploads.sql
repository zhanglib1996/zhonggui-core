-- 文件上传记录表
CREATE TABLE IF NOT EXISTS file_uploads (
  id VARCHAR(21) PRIMARY KEY,
  user_id VARCHAR(50) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_path VARCHAR(500) NOT NULL,
  mime_type VARCHAR(100),
  size INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_file_uploads_user_id ON file_uploads(user_id);
