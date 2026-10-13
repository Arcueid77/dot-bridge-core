import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('win_private', Path(__file__).with_name('windows.py'))
win = importlib.util.module_from_spec(spec)
if sys.platform == 'win32':
    spec.loader.exec_module(win)


@unittest.skipUnless(sys.platform == 'win32', 'Native Windows integration suite')
class WindowsSafetyTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix='windows-platform-synthetic-'))
        self.addCleanup(lambda: shutil.rmtree(self.root))
        self.directory = self.root / 'private'
        with win.Directory(str(self.directory), create=True):
            pass
        self.file = self.directory / 'fixture.json'
        self.payload = json.dumps({'synthetic': True}).encode()

    def test_creation_acl_is_owner_system_only_and_handle_read_is_bounded(self):
        metadata = win.inspect(str(self.directory), directory=True)
        self.assertTrue(metadata['owner_matches'])
        self.assertTrue(metadata['protected_dacl'])
        win.write_new(str(self.file), self.payload)
        self.assertEqual(win.read(str(self.file)), self.payload)
        self.assertTrue(win.inspect(str(self.file))['private'])
        with self.assertRaises(win.Unsafe):
            win.read(str(self.file), limit=2)
        with self.assertRaises(win.Unsafe):
            win.read(str(self.file), exact=1)

    def test_exclusive_atomic_write_preserves_existing_destination(self):
        win.write_new(str(self.file), self.payload)
        with self.assertRaises(OSError):
            win.write_new(str(self.file), b'replacement fixture')
        self.assertEqual(win.read(str(self.file)), self.payload)
        self.assertEqual(sorted(p.name for p in self.directory.iterdir()), ['fixture.json'])

    def test_non_private_existing_directory_is_rejected_without_acl_repair(self):
        with self.assertRaises(win.Unsafe):
            win.Directory(str(self.root))
        with self.assertRaises(win.Unsafe):
            win.Directory(str(self.root), create=True)

    def test_hardlink_and_reserved_stream_names_are_rejected(self):
        win.write_new(str(self.file), self.payload)
        os.link(self.file, self.directory / 'alias.json')
        with self.assertRaises(win.Unsafe):
            win.read(str(self.file))
        for invalid in ('fixture.json:stream', 'NUL', 'trailing.', 'bad ', '..'):
            with self.subTest(invalid=invalid), self.assertRaises(win.Unsafe):
                win.read(str(self.directory / invalid))

    def test_pinned_ancestor_cannot_be_replaced_during_operation(self):
        with win.Directory(str(self.directory)):
            with self.assertRaises(OSError):
                os.rename(self.directory, self.root / 'moved-private')
            with self.assertRaises(OSError):
                os.rename(self.root, self.root.with_name(self.root.name + '-moved'))
        os.rename(self.directory, self.root / 'moved-private')

    def test_null_or_foreign_owner_acl_is_rejected_before_bytes_are_read(self):
        win.write_new(str(self.file), self.payload)
        with mock.patch.object(win, 'SID', 'S-1-5-21-0-0-0-9999'):
            with self.assertRaises(win.Unsafe):
                win.read(str(self.file))

    def test_actual_null_dacl_is_rejected_before_readfile(self):
        win.write_new(str(self.file), self.payload)
        with win.Directory(str(self.directory)) as parent:
            handle = win.relative(parent.handle, self.file.name, access=win.READ_CONTROL | 0x40000 | win.SYNCHRONIZE)
            try:
                set_security = win.api(win.advapi, 'SetSecurityInfo', [win.HANDLE, win.c.c_int, win.DWORD, win.HANDLE, win.HANDLE, win.HANDLE, win.HANDLE], win.DWORD)
                win.check(set_security(handle, 1, 4 | 0x80000000, None, None, None, None) == 0)
                with mock.patch.object(win, 'ReadFile', side_effect=AssertionError('content read before ACL check')):
                    with self.assertRaises(win.Unsafe) as error: win.read(str(self.file))
                    self.assertEqual(error.exception.code,'acl')
            finally: win.CloseHandle(handle)

    def test_helper_protocol_rejects_extra_fields_and_invalid_types_before_io(self):
        invalid = [
            {'operation':'pin_directory','path':str(self.directory),'create':'yes'},
            {'operation':'read','path':str(self.file),'limit':True},
            {'operation':'read','path':str(self.file),'exact':-1},
            {'operation':'write_new','path':str(self.file),'data':'','overwrite':True},
            {'operation':'close','handles':[],'digest':'not-a-digest'},
        ]
        with mock.patch.object(win,'Directory',side_effect=AssertionError('object opened')):
            for request in invalid:
                with self.subTest(request=request), self.assertRaises(win.Unsafe): win.dispatch(request)
            for entry in ('fixture.json:stream', 'NUL', 'trailing.', 'bad ', '..'):
                for operation in (win.inspect, win.remove_private):
                    with self.subTest(entry=entry, operation=operation.__name__), self.assertRaises(win.Unsafe) as error:
                        operation(str(self.directory / entry))
                    self.assertEqual(error.exception.code, 'path')
        fake = {'handle':4,'identity':['00000000','0000000000000000']}
        with mock.patch.object(win,'OpenProcess',side_effect=AssertionError('process handle opened')):
            with self.assertRaises(win.Unsafe): win.parent_handles([fake,fake])


if __name__ == '__main__':
    unittest.main()
