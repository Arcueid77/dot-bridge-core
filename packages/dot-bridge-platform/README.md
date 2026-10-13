# Native Windows private storage

This package adds the Windows branch used by the sibling QQ/Lark bridges, the
aggregator and finite-window supervisor. Existing Linux descriptor-relative
branches remain available. It has no provider, callback, account or network API.

Use Node 24.15+ in major 24 and an existing trusted Python 3.10+ interpreter.
`DOT_BRIDGE_PYTHON` selects its absolute path. If absent, standalone Node tools
inspect only the standard existing uv interpreter directory in the user profile.
They do not download Python, run a shell, initialize a cache or inspect arbitrary
environment values. The supervisor explicitly selects its own interpreter.
Python helpers run with `-B -I -S` and a small Windows runtime environment.

## File boundary

- Accept canonical absolute paths on local fixed NTFS drives. Reject UNC/device
  namespaces, alternate data streams, reserved names, trailing dots/spaces and
  normalization changes. Other filesystems/platforms fail closed.
- Pin every ancestor using relative `NtCreateFile` opens with
  `OBJ_DONT_REPARSE`/`FILE_OPEN_REPARSE_POINT`. Directory handles include data/list
  access and omit delete sharing, so a checked ancestor cannot be renamed while
  an operation or lease remains active. Existing directory ACLs are never changed.
- Require the current token SID as owner. Private leaf directories have a
  protected DACL granting full access only to that SID and SYSTEM. Files have
  only those effective allowed principals and full owner access; safely inherited
  file ACLs are accepted for SQLite WAL/SHM. Null/unknown/foreign ACLs fail closed.
- Reject reparse points, non-disk/nonregular files, multiple hard links, size and
  identity changes. Reads are bounded and validated before/after reading.
- Publish a newly written credential through a flushed private temporary file
  and relative atomic no-overwrite rename. Its DACL is set at creation. Failed
  writes remove only the object held by the creator's native handle.
- Validate all existing database sidecars before creating a database. Hold its
  main file and directory/ancestor handles for the full SQLite lifetime. The
  private parent controls new SQLite sidecars; credentials and persisted message
  fields retain their existing application encryption. Same-owner or privileged
  ACL changes during SQLite use are outside this boundary.

The owning SID and privileged administrators/SYSTEM are outside the confidentiality
boundary, as the owning UID and root are on Linux. ACL checks do not establish
ChatGPT or provider identity and do not authorize credential reuse or live traffic.

## Native leases and private control

The helper duplicates non-inheritable handles into its actual parent Node process.
These are opaque kernel handles, never Node/crt file descriptor numbers. Closing
requires matching opaque file identities; an uncertain close is never retried.
Only an explicit rejection before any parent handle close permits a retry.
Windows also validates the helper's request/response schema and unique handles.
Process exit closes remaining handles, but stale lock files require explicit review.

Mode locks retain a private owner record and refuse a competing mode. Release
checks owner/DACL, identity, link count and record digest, then deletes by held
handle. It cannot unlink a replacement pathname. No stale takeover is provided.

The finite-window supervisor uses LockFileEx and owned Job Objects. Node's private
inherited stdin pipe accepts only `stop\n` or EOF. Startup rejection detaches that
pipe and exits even while the parent keeps its writer open. This control channel
is enabled only by the supervisor flag and does not create an HTTP/MCP endpoint.

## Tests and verified limits

`test-fixtures.js` creates fresh private synthetic Temp trees. Its separate ACL
mutator operates only on registered test trees with the synthetic naming marker;
production APIs cannot repair a directory ACL. Negative permission tests change
real DACLs. Junction fixtures exercise real final/ancestor/dangling reparse points
without installing software or granting symlink privilege. RMB16 lacks native
file-symlink creation privilege; these results must not be described as actual
file-symlink fixtures.

```powershell
node --test --test-concurrency=1 test/windows-platform.test.js
& 'C:\path\to\python.exe' -B -m unittest discover -s packages/dot-bridge-platform -p test_windows.py -v
node --test packages/dot-bridge-platform/test-node.mjs
```

Run as the intended normal Windows user; an offline sandbox account may be unable
to traverse that user's directory ancestors and must refuse access. The RMB16
cross-token probe additionally verified that a public synthetic file created by
the sandbox account was rejected by the normal account before content reading.
No saved credentials, real Tunnel client, provider account or real subscription
are part of these tests. Native Windows results do not verify Linux execution or
current-dot delivery. The exact code also needs a separate Linux regression run.

Win32 contracts used here: [CreateFile](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew),
[GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo),
[relative Nt/ZwCreateFile semantics](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/nf-wdm-zwcreatefile),
[DuplicateHandle](https://learn.microsoft.com/en-us/windows/win32/api/handleapi/nf-handleapi-duplicatehandle),
[LockFileEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex),
and [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
