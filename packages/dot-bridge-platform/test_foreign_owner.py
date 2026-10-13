"""RMB16 cross-token fixture probe. Uses only the fixed public synthetic file."""
import ctypes as c
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

if sys.platform == 'win32':
    sys.path.insert(0, str(Path(__file__).parent))
    import windows as win

def main():
    if sys.platform != 'win32':
        print(json.dumps({'skipped': True, 'reason': 'Native Windows probe'}))
        return
    source = Path(__file__).resolve().parents[3] / 'foreign-owner-synthetic-fixture.tmp'
    root = Path(tempfile.mkdtemp(prefix='foreign-owner-synthetic-'))
    target = root / 'private' / 'foreign.txt'
    try:
        with win.Directory(str(target.parent), create=True) as parent:
            os.replace(source, target)
            handle = win.relative(parent.handle, target.name)
            owner, descriptor = win.HANDLE(), win.HANDLE()
            try:
                win.check(win.GetSecurityInfo(handle, 1, 1, c.byref(owner), None, None, None, c.byref(descriptor)) == 0)
                foreign = win.sid_text(owner) != win.SID
            finally:
                if descriptor: win.LocalFree(descriptor)
                win.CloseHandle(handle)
            if not foreign: raise AssertionError('fixture did not retain distinct owner')
            try: win.read(str(target)); raise AssertionError('foreign owner accepted')
            except win.Unsafe as error:
                if error.code != 'acl': raise
        print(json.dumps({'foreign_owner_verified': True, 'read_rejected_before_content': True, 'real_credentials_read': False}))
    finally:
        shutil.rmtree(root)

if __name__ == '__main__': main()
