Here is a comprehensive technical documentation explaining the new RBAC (Role-Based Access Control) architecture for the `redpash` system, specifically focusing on how CRUD (Create, Read, Update, Delete) operations are evaluated.

---

# RedPash RBAC Architecture Documentation

## 1. Overview

The RedPash RBAC system is built on a **Polymorphic Hierarchical Membership** model. Instead of relying on hardcoded ownership columns (`owner_id`, `assignee_id`) or parallel join tables, all access control is governed by a single, unified `memberships` table.

Because all domain objects (Companies, Projects, Cases, Teams) are registered in the `entities` supertype, the system can dynamically evaluate permissions for *any* object using the exact same logic.

## 2. Core Primitives

Access is determined by two fields on a `memberships` row:

* **`role` (The System Permission):** A strict ENUM of `owner`, `admin`, `member`, or `viewer`. This dictates the actual database-level capability of the user regarding that object.
* **`context_role` (The Business Descriptor):** A free-text string (e.g., "CEO", "Case Owner", "Reporter", "Data Analyst"). This is used for UI labels and workflow context, but *does not* override the base `role`.

## 3. The Hierarchy of Access (Inheritance)

Permissions in RedPash cascade downwards. A user's effective permission on a target object is the **highest** of:

1. **Direct Access:** Their explicit membership on the object itself.
2. **Team Access:** Their membership in a Team that has a business rule granting access (e.g., Support Team -> All Cases).
3. **Parent Access:** Their membership on the parent Company.

*Example: If Alice is a `viewer` directly on Project A, but she is an `owner` of the Company that owns Project A, her effective permission on Project A is upgraded to `owner`.*

---

## 4. CRUD Matrix & Evaluation Rules

Whenever the backend receives a request, it evaluates access using the following standard rules for Create, Read, Update, and Delete.

### 🟩 Create (C)

Creation rights are evaluated against the **Parent Object**.

* **To create a Company:** Any authenticated user can do this. The creator is instantly granted a `memberships` row on that Company with `role = 'owner'`.
* **To create a Project, Team, or Case:** The user must be explicitly assigned to the parent Company with a `role` of `member`, `admin`, or `owner`.
* *Note:* `viewer`s at the Company level cannot create new child objects.


* **Auto-assignment:** When a user creates an object, the backend automatically assigns them a membership on that new object. (e.g., creating a Project makes them `owner`; reporting a Case makes them `member` with `context_role = 'Reporter'`).

### 🟦 Read (R)

Visibility is additive. To view an object, the user must have at least `viewer` access directly or via inheritance.

* **Direct:** The user has a `memberships` row on the object (`viewer`, `member`, `admin`, or `owner`).
* **Inherited:** The user is an `admin` or `owner` of the parent Company.
* **Business Rule (Teams):** The user belongs to a Team that explicitly grants visibility (e.g., HR can only see Cases they reported; Support Engineers can see *all* Cases).

### 🟨 Update (U)

Updates include editing descriptions, changing status, or adding files/comments.

* **Base Rule:** Requires `member`, `admin`, or `owner` on the target object.
* **Granular Fields:** While `member` allows standard updates (progressing a Case status, uploading a file to a Project), destructive or administrative updates (e.g., changing a Project's visibility to Public, renaming the Company) require `admin` or `owner` status.
* **Inherited:** An `admin` or `owner` of the parent Company automatically holds Update rights on all child objects.

### 🟥 Delete (D)

Deletion is strictly guarded to prevent accidental data loss and orphan records.

* **Base Rule:** Requires `owner` status on the specific object being deleted. In some specific workflows, an `admin` may delete lower-level objects (like a comment or a file), but top-level objects (Projects, Cases) require `owner`.
* **Inherited:** The `owner` of a Company can delete any child Project or Case within that Company, bypassing direct object ownership.
* **The Blocker Rule:** A Company or Project cannot be deleted if the user is the *sole* owner and their account is being deleted (requires ownership transfer).

---

## 5. Implementation Examples (Backend Logic)

Here is how the API endpoints verify these CRUD permissions using the `memberships` table.

### Example A: Can the user UPDATE a specific Case? (Direct or Inherited)

```sql
-- Check if User has 'member' (or higher) directly on the Case, 
-- OR if they are an 'admin'/'owner' of the parent Company.
SELECT m.role 
FROM cases c
-- 1. Check Direct Membership
LEFT JOIN memberships m ON m.object_redpash_id = c.redpash_id AND m.user_redpash_id = $1
-- 2. Check Inherited Company Membership
LEFT JOIN memberships cm ON cm.object_redpash_id = c.company_id AND cm.user_redpash_id = $1
WHERE c.redpash_id = 'CAS_123'
  AND (
      m.role IN ('member', 'admin', 'owner') 
      OR 
      cm.role IN ('admin', 'owner')
  );

```

*If this query returns a row, the `PATCH /api/cases/:id` request proceeds.*

### Example B: Can the user READ a Project? (Team/Business Rule)

Suppose we want to fetch the list of Projects for a dashboard. The user sees projects they are explicitly in, OR projects belonging to their Company if they are a Company Admin.

```sql
SELECT p.* FROM projects p
JOIN memberships m ON m.object_redpash_id = p.redpash_id
WHERE m.user_redpash_id = 'USR_456' AND m.role IN ('viewer', 'member', 'admin', 'owner')
UNION
-- Add projects where the user is an admin/owner of the parent company
SELECT p.*
FROM projects p
JOIN memberships cm ON cm.object_redpash_id = p.company_id
WHERE cm.user_redpash_id = 'USR_456' AND cm.role IN ('admin', 'owner');

```

### Example C: Object Creation (Assigning initial ownership)

When a user `POST /api/projects` to create a new workspace:

1. **Verify Parent:** Check if `user` is `member`, `admin`, or `owner` of `CMP_789`.
2. **Insert Entity:** `INSERT INTO entities (id, type) VALUES ('PRJ_999', 'project');`
3. **Insert Object:** `INSERT INTO projects (redpash_id, company_id, name) VALUES ('PRJ_999', 'CMP_789', 'New Workspace');`
4. **Grant Ownership:** `INSERT INTO memberships (object_redpash_id, user_redpash_id, role, context_role) VALUES ('PRJ_999', 'USR_456', 'owner', 'Project Creator');`
*(All performed in a single SQL transaction).*