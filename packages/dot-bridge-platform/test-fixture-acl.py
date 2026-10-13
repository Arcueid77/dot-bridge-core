"""ACL mutations for freshly created synthetic Temp fixtures only. Never runtime."""
import ctypes as c
from ctypes import wintypes as w
import json
import ntpath
import os
import re
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).parent))
import windows as win

def main():
    handle, descriptor = None, win.HANDLE()
    try:
        value = json.loads(sys.stdin.read(8192))
        root, path, mode = value['root'], value['path'], value['mode']
        win.canonical(root); win.canonical(path)
        if ntpath.dirname(root).casefold() != ntpath.normpath(tempfile.gettempdir()).casefold() or not re.fullmatch(r'[a-zA-Z0-9_-]*bridge-synthetic-[a-zA-Z0-9_-]*[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', ntpath.basename(root)):
            raise win.Unsafe('input')
        if path != root and not path.casefold().startswith(root.casefold() + '\\'):
            raise win.Unsafe('input')
        if type(mode) is not int or not 0 <= mode <= 0o7777:
            raise win.Unsafe('input')
        handle = win.CreateFile(path, win.READ_CONTROL | 0x40000 | win.FILE_READ_ATTRIBUTES,
                                win.SHARE_READ | win.SHARE_WRITE, None, 3, 0x02000000 | 0x00200000, None)
        if handle in (None, win.INVALID): raise win.Unsafe()
        metadata = win.info(handle)
        owner, sd = win.HANDLE(), win.HANDLE()
        win.check(win.GetSecurityInfo(handle, 1, 1, c.byref(owner), None, None, None, c.byref(sd)) == 0)
        try:
            if win.sid_text(owner) != win.SID: raise win.Unsafe('acl')
        finally: win.LocalFree(sd)
        flags = 'OICI' if metadata['directory'] else ''
        # Non-private POSIX fixtures become real non-private DACLs. Read-only
        # owner modes become an owner read-only ACL; exact private modes have FA.
        expected = 0o700 if metadata['directory'] else 0o600
        owner_access = 'FA' if mode & 0o700 == expected else 'FR'
        extra = f'(A;{flags};FR;;;WD)' if mode & 0o077 or mode & 0o7000 else ''
        sddl = f'O:{win.SID}D:P(A;{flags};{owner_access};;;{win.SID})(A;{flags};FA;;;SY)' + extra
        win.check(win.ConvertSddl(sddl, 1, c.byref(descriptor), None))
        get_dacl = win.api(win.advapi, 'GetSecurityDescriptorDacl', [win.HANDLE, c.POINTER(w.BOOL), c.POINTER(win.HANDLE), c.POINTER(w.BOOL)])
        present, defaulted, dacl = w.BOOL(), w.BOOL(), win.HANDLE()
        win.check(get_dacl(descriptor, c.byref(present), c.byref(dacl), c.byref(defaulted)))
        set_security = win.api(win.advapi, 'SetSecurityInfo', [win.HANDLE, c.c_int, win.DWORD, win.HANDLE, win.HANDLE, win.HANDLE, win.HANDLE], win.DWORD)
        win.check(set_security(handle, 1, 4 | 0x80000000, None, None, dacl, None) == 0)
        print('{"ok":true}')
        return 0
    except BaseException:
        print('{"ok":false}')
        return 1
    finally:
        if descriptor: win.LocalFree(descriptor)
        if handle not in (None, win.INVALID): win.CloseHandle(handle)

if __name__ == '__main__': raise SystemExit(main())
