-- auth의 private schema를 runtime import하지 않고 DDL에서 계정 관계를 연결한다.
ALTER TABLE materials ADD CONSTRAINT materials_owner_account_fk
  FOREIGN KEY (owner_id) REFERENCES accounts(id);
--> statement-breakpoint
-- material을 먼저 insert한 뒤 같은 transaction에서 revision을 만든다.
-- commit 시에는 반드시 같은 owner/material의 실제 revision을 가리켜야 한다.
ALTER TABLE materials ADD CONSTRAINT materials_current_revision_fk
  FOREIGN KEY (owner_id, id, current_revision_id)
  REFERENCES material_revisions(owner_id, material_id, id)
  DEFERRABLE INITIALLY DEFERRED;
