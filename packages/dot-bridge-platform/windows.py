"""Local NTFS safety primitives. No account, network, ACL repair or log access.

Private leaf directories have a protected owner/SYSTEM-only DACL. Existing
objects are validated by handle; new objects receive their DACL at creation.
Every ancestor is opened relative to a pinned directory handle, without reparse
processing or delete sharing. Privileged administrators and the owning SID are
outside the confidentiality boundary, just as root/the owning UID are on Linux.
"""
import base64
import ctypes as c
from ctypes import wintypes as w
import hashlib
import json
import ntpath
import os
import re
import sys
import uuid

if sys.platform != 'win32':
    raise ImportError('Windows platform required')

kernel = c.WinDLL('kernel32', use_last_error=True)
advapi = c.WinDLL('advapi32', use_last_error=True)
ntdll = c.WinDLL('ntdll')
HANDLE = c.c_void_p
DWORD = w.DWORD
ULONG_PTR = c.c_size_t
INVALID = c.c_void_p(-1).value
READ_CONTROL = 0x20000
SYNCHRONIZE = 0x100000
DELETE = 0x10000
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
FILE_ALL_ACCESS = 0x1F01FF
FILE_READ_ATTRIBUTES = 0x80
FILE_LIST_DIRECTORY = 1
FILE_TRAVERSE = 0x20
SHARE_READ, SHARE_WRITE, SHARE_DELETE = 1, 2, 4
DIRECTORY_ATTRIBUTE, REPARSE_ATTRIBUTE = 0x10, 0x400
FILE_OPEN, FILE_CREATE, FILE_OPEN_IF = 1, 2, 3
SYSTEM_SID = 'S-1-5-18'


class Unsafe(OSError):
    def __init__(self, code='io'):
        self.code = code
        super().__init__('Windows private object is unavailable or unsafe')


def api(dll, name, args, result=w.BOOL):
    function = getattr(dll, name)
    function.argtypes, function.restype = args, result
    return function


CloseHandle = api(kernel, 'CloseHandle', [HANDLE])
GetCurrentProcess = api(kernel, 'GetCurrentProcess', [], HANDLE)
OpenProcess = api(kernel, 'OpenProcess', [DWORD, w.BOOL, DWORD], HANDLE)
DuplicateHandle = api(kernel, 'DuplicateHandle', [HANDLE, HANDLE, HANDLE, c.POINTER(HANDLE), DWORD, w.BOOL, DWORD])
CreateFile = api(kernel, 'CreateFileW', [w.LPCWSTR, DWORD, DWORD, HANDLE, DWORD, DWORD, HANDLE], HANDLE)
LocalFree = api(kernel, 'LocalFree', [HANDLE], HANDLE)
ReadFile = api(kernel, 'ReadFile', [HANDLE, HANDLE, DWORD, c.POINTER(DWORD), HANDLE])
WriteFile = api(kernel, 'WriteFile', [HANDLE, HANDLE, DWORD, c.POINTER(DWORD), HANDLE])
FlushFileBuffers = api(kernel, 'FlushFileBuffers', [HANDLE])
SetEndOfFile = api(kernel, 'SetEndOfFile', [HANDLE])
SetFilePointerEx = api(kernel, 'SetFilePointerEx', [HANDLE, c.c_longlong, c.POINTER(c.c_longlong), DWORD])
SetFileInformation = api(kernel, 'SetFileInformationByHandle', [HANDLE, c.c_int, HANDLE, DWORD])
GetFinalPath = api(kernel, 'GetFinalPathNameByHandleW', [HANDLE, w.LPWSTR, DWORD, DWORD], DWORD)
GetVolumeInformation = api(kernel, 'GetVolumeInformationByHandleW', [HANDLE, w.LPWSTR, DWORD, c.POINTER(DWORD), c.POINTER(DWORD), c.POINTER(DWORD), w.LPWSTR, DWORD])
GetDriveType = api(kernel, 'GetDriveTypeW', [w.LPCWSTR], DWORD)
GetFileType = api(kernel, 'GetFileType', [HANDLE], DWORD)
OpenProcessToken = api(advapi, 'OpenProcessToken', [HANDLE, DWORD, c.POINTER(HANDLE)])
GetTokenInformation = api(advapi, 'GetTokenInformation', [HANDLE, c.c_int, HANDLE, DWORD, c.POINTER(DWORD)])
ConvertSidToString = api(advapi, 'ConvertSidToStringSidW', [HANDLE, c.POINTER(w.LPWSTR)])
ConvertSddl = api(advapi, 'ConvertStringSecurityDescriptorToSecurityDescriptorW', [w.LPCWSTR, DWORD, c.POINTER(HANDLE), c.POINTER(DWORD)])
GetSecurityInfo = api(advapi, 'GetSecurityInfo', [HANDLE, c.c_int, DWORD, c.POINTER(HANDLE), c.POINTER(HANDLE), c.POINTER(HANDLE), c.POINTER(HANDLE), c.POINTER(HANDLE)], DWORD)
GetSecurityDescriptorControl = api(advapi, 'GetSecurityDescriptorControl', [HANDLE, c.POINTER(w.WORD), c.POINTER(DWORD)])
GetAce = api(advapi, 'GetAce', [HANDLE, DWORD, c.POINTER(HANDLE)])


class FileInfo(c.Structure):
    _fields_ = [('attributes', DWORD), ('creation', w.FILETIME), ('access', w.FILETIME),
                ('write', w.FILETIME), ('volume', DWORD), ('size_high', DWORD),
                ('size_low', DWORD), ('links', DWORD), ('index_high', DWORD), ('index_low', DWORD)]


class UnicodeString(c.Structure):
    _fields_ = [('Length', w.USHORT), ('MaximumLength', w.USHORT), ('Buffer', w.LPWSTR)]


class ObjectAttributes(c.Structure):
    _fields_ = [('Length', DWORD), ('RootDirectory', HANDLE), ('ObjectName', c.POINTER(UnicodeString)),
                ('Attributes', DWORD), ('SecurityDescriptor', HANDLE), ('SecurityQualityOfService', HANDLE)]


class IoStatus(c.Structure):
    _fields_ = [('Status', ULONG_PTR), ('Information', ULONG_PTR)]


class Acl(c.Structure):
    _fields_ = [('revision', w.BYTE), ('reserved', w.BYTE), ('size', w.WORD),
                ('count', w.WORD), ('reserved2', w.WORD)]


GetFileInformation = api(kernel, 'GetFileInformationByHandle', [HANDLE, c.POINTER(FileInfo)])
NtCreateFile = api(ntdll, 'NtCreateFile', [c.POINTER(HANDLE), DWORD, c.POINTER(ObjectAttributes), c.POINTER(IoStatus), HANDLE, DWORD, DWORD, DWORD, DWORD, HANDLE, DWORD], c.c_long)
NtSetInformationFile = api(ntdll, 'NtSetInformationFile', [HANDLE, c.POINTER(IoStatus), HANDLE, DWORD, c.c_int], c.c_long)
RtlNtStatusToDosError = api(ntdll, 'RtlNtStatusToDosError', [c.c_long], DWORD)


def check(value):
    if not value:
        raise Unsafe()
    return value


def sid_text(sid):
    result = w.LPWSTR()
    check(ConvertSidToString(sid, c.byref(result)))
    try:
        return result.value
    finally:
        LocalFree(c.cast(result, HANDLE))


def current_sid():
    token, length = HANDLE(), DWORD()
    check(OpenProcessToken(GetCurrentProcess(), 8, c.byref(token)))
    try:
        GetTokenInformation(token, 1, None, 0, c.byref(length))
        buffer = c.create_string_buffer(length.value)
        check(GetTokenInformation(token, 1, buffer, length, c.byref(length)))
        return sid_text(c.cast(buffer, c.POINTER(HANDLE))[0])
    finally:
        CloseHandle(token)


SID = current_sid()


class Security:
    def __init__(self, directory=False):
        self.pointer = HANDLE()
        flags = 'OICI' if directory else ''
        check(ConvertSddl(f'O:{SID}D:P(A;{flags};FA;;;{SID})(A;{flags};FA;;;SY)', 1, c.byref(self.pointer), None))

    def close(self):
        LocalFree(self.pointer)


def info(handle, *, directory=None, max_bytes=None):
    result = FileInfo()
    check(GetFileInformation(handle, c.byref(result)))
    if GetFileType(handle) != 1 or result.attributes & REPARSE_ATTRIBUTE:
        raise Unsafe('reparse')
    is_directory = bool(result.attributes & DIRECTORY_ATTRIBUTE)
    if directory is not None and is_directory != directory:
        raise Unsafe('type')
    size = (result.size_high << 32) | result.size_low
    if not is_directory and (result.links != 1 or (max_bytes is not None and size > max_bytes)):
        raise Unsafe('links' if result.links != 1 else 'size')
    return {'identity': [f'{result.volume:08x}', f'{((result.index_high << 32) | result.index_low):016x}'],
            'size': size, 'directory': is_directory, 'links': result.links}


def private(handle, *, directory=False, max_bytes=None):
    metadata = info(handle, directory=directory, max_bytes=max_bytes)
    owner, dacl, descriptor = HANDLE(), HANDLE(), HANDLE()
    check(GetSecurityInfo(handle, 1, 1 | 4, c.byref(owner), None, c.byref(dacl), None, c.byref(descriptor)) == 0)
    try:
        control, revision = w.WORD(), DWORD()
        check(GetSecurityDescriptorControl(descriptor, c.byref(control), c.byref(revision)))
        if sid_text(owner) != SID or not dacl or not control.value & 4:
            raise Unsafe('acl')
        if directory and not control.value & 0x1000:
            raise Unsafe('acl')
        acl = c.cast(dacl, c.POINTER(Acl)).contents
        owner_access = 0
        if not 1 <= acl.count <= 8:
            raise Unsafe('acl')
        for index in range(acl.count):
            ace = HANDLE()
            check(GetAce(dacl, index, c.byref(ace)))
            header = c.string_at(ace, 4)
            if header[0] != 0 or int.from_bytes(header[2:4], 'little') < 16:
                raise Unsafe('acl')
            mask = c.c_uint32.from_address(ace.value + 4).value
            trustee = sid_text(ace.value + 8)
            if trustee not in (SID, SYSTEM_SID):
                raise Unsafe('acl')
            if trustee == SID and not header[1] & 8:
                owner_access |= mask
        if owner_access & FILE_ALL_ACCESS != FILE_ALL_ACCESS and not owner_access & 0x10000000:
            raise Unsafe('acl')
        return {**metadata, 'private': True, 'owner_matches': True, 'protected_dacl': bool(control.value & 0x1000)}
    finally:
        LocalFree(descriptor)


def canonical(raw):
    if not isinstance(raw, str) or not raw or len(raw) > 2048 or '\x00' in raw or ntpath.normpath(raw) != raw:
        raise Unsafe('path')
    drive, tail = ntpath.splitdrive(raw)
    if not re.fullmatch('[a-zA-Z]:', drive) or not tail.startswith('\\') or GetDriveType(drive + '\\') != 3:
        raise Unsafe('filesystem')
    parts = tail[1:].split('\\') if tail[1:] else []
    for part in parts:
        if not part or part in ('.', '..') or part[-1] in ' .' or re.search(r'[<>:"/\\|?*\x00-\x1f]', part) or re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', part, re.I):
            raise Unsafe('path')
    return drive, parts


def relative(parent, name, *, directory=False, create=False, exclusive=False, access=None, share=SHARE_READ | SHARE_WRITE):
    if not isinstance(name, str) or not name or re.search(r'[\\/:\x00]', name) or name in ('.', '..'):
        raise Unsafe('path')
    text = c.create_unicode_buffer(name)
    encoded_length = len(name.encode('utf-16-le'))
    string = UnicodeString(encoded_length, encoded_length + 2, c.cast(text, w.LPWSTR))
    security = Security(directory) if create else None
    attributes = ObjectAttributes(c.sizeof(ObjectAttributes), parent, c.pointer(string), 0x40 | 0x1000, security.pointer if security else None, None)
    handle, status = HANDLE(), IoStatus()
    desired = access if access is not None else FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE
    try:
        result = NtCreateFile(c.byref(handle), desired, c.byref(attributes), c.byref(status), None,
                              DIRECTORY_ATTRIBUTE if directory else 0x80, share,
                              FILE_CREATE if exclusive else FILE_OPEN_IF if create else FILE_OPEN,
                              0x20 | 0x200000 | (1 if directory else 0x40), None, 0)
        if result < 0:
            code = RtlNtStatusToDosError(result)
            if code in (2, 3):
                raise FileNotFoundError()
            if code in (80, 183):
                raise FileExistsError()
            if result & 0xffffffff == 0xC000050B or code in (1920, 4390):
                raise Unsafe('reparse')
            raise Unsafe('io')
        return handle.value
    finally:
        if security:
            security.close()


class Directory:
    def __init__(self, path, *, create=False, private_leaf=True):
        drive, parts = canonical(path)
        if not parts:
            raise Unsafe('path')
        self.handles = []
        try:
            root = CreateFile('\\\\?\\' + drive + '\\', FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE, SHARE_READ | SHARE_WRITE, None, 3, 0x02000000 | 0x00200000, None)
            if root in (None, INVALID):
                raise Unsafe()
            self.handles.append(root)
            info(root, directory=True)
            filesystem = c.create_unicode_buffer(64)
            check(GetVolumeInformation(root, None, 0, None, None, None, filesystem, 64))
            if filesystem.value != 'NTFS':
                raise Unsafe('filesystem')
            for index, part in enumerate(parts):
                final = index == len(parts) - 1
                child = relative(self.handles[-1], part, directory=True, create=create,
                                 access=FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE | (READ_CONTROL if final else 0))
                self.handles.append(child)
                info(child, directory=True)
            if private_leaf:
                private(self.handle, directory=True)
            self.path = path
        except BaseException:
            self.close()
            raise

    @property
    def handle(self):
        return self.handles[-1]

    def close(self):
        for handle in reversed(self.handles):
            CloseHandle(handle)
        self.handles = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def read_handle(handle, limit):
    check(SetFilePointerEx(handle, 0, None, 0))
    buffer = c.create_string_buffer(limit + 1)
    count = DWORD()
    check(ReadFile(handle, buffer, limit + 1, c.byref(count), None))
    if count.value > limit:
        raise Unsafe('size')
    return buffer.raw[:count.value]


def read(path, *, limit=16384, exact=None):
    canonical(path)
    with Directory(ntpath.dirname(path)) as parent:
        handle = relative(parent.handle, ntpath.basename(path), access=GENERIC_READ | READ_CONTROL | SYNCHRONIZE, share=SHARE_READ)
        try:
            original = private(handle, max_bytes=limit)
            data = read_handle(handle, limit)
            private(parent.handle, directory=True)
            if private(handle, max_bytes=limit)['identity'] != original['identity'] or (exact is not None and len(data) != exact):
                raise Unsafe('size')
            return data
        finally:
            CloseHandle(handle)


def dispose(handle):
    deleted = w.BOOL(True)
    check(SetFileInformation(handle, 4, c.byref(deleted), c.sizeof(deleted)))


def rename_new(handle, parent, name):
    class Rename(c.Structure):
        _fields_ = [('replace', w.BOOL), ('root', HANDLE), ('length', DWORD), ('name', w.WCHAR * len(name))]
    record = Rename(False, parent, len(name.encode('utf-16-le')), name)
    status = IoStatus()
    if NtSetInformationFile(handle, c.byref(status), c.byref(record), c.sizeof(record), 10) < 0:
        raise Unsafe()


def write_new(path, data, *, retain=False):
    canonical(path)
    if not isinstance(data, bytes) or len(data) > 512000:
        raise Unsafe('size')
    parent = Directory(ntpath.dirname(path))
    handle = None
    try:
        temporary = '.private-' + uuid.uuid4().hex + '.tmp'
        handle = relative(parent.handle, temporary, create=True, exclusive=True,
                          access=GENERIC_READ | GENERIC_WRITE | READ_CONTROL | DELETE | SYNCHRONIZE,
                          share=SHARE_READ if retain else 0)
        private(handle, max_bytes=512000)
        buffer = c.create_string_buffer(data)
        try:
            count = DWORD()
            check(WriteFile(handle, buffer, len(data), c.byref(count), None))
            if count.value != len(data):
                raise Unsafe()
            check(FlushFileBuffers(handle))
        finally:
            c.memset(buffer, 0, c.sizeof(buffer))
        private(parent.handle, directory=True)
        private(handle, max_bytes=512000)
        rename_new(handle, parent.handle, ntpath.basename(path))
        if retain:
            return parent, handle
    except BaseException:
        if handle is not None:
            try:
                dispose(handle)
            except OSError:
                pass
        raise
    finally:
        if not retain or sys.exc_info()[0] is not None:
            if handle is not None:
                CloseHandle(handle)
            parent.close()


def write_metadata(path, data):
    """Overwrite only the validated, exclusively opened object; never its path."""
    canonical(path)
    if not isinstance(data, bytes) or len(data) > 512000:
        raise Unsafe('size')
    with Directory(ntpath.dirname(path)) as parent:
        try:
            handle = relative(parent.handle, ntpath.basename(path), access=GENERIC_READ | GENERIC_WRITE | READ_CONTROL | SYNCHRONIZE, share=0)
        except FileNotFoundError:
            return write_new(path, data)
        try:
            original = private(handle, max_bytes=512000)
            check(SetFilePointerEx(handle, 0, None, 0)); check(SetEndOfFile(handle))
            buffer, count = c.create_string_buffer(data), DWORD()
            try:
                check(WriteFile(handle, buffer, len(data), c.byref(count), None))
                if count.value != len(data): raise Unsafe()
                check(FlushFileBuffers(handle))
            finally:
                c.memset(buffer, 0, c.sizeof(buffer))
            private(parent.handle, directory=True)
            if private(handle, max_bytes=512000)['identity'] != original['identity']: raise Unsafe('identity')
        finally:
            CloseHandle(handle)


def remove_private(path, *, expected=None):
    canonical(path)
    with Directory(ntpath.dirname(path)) as parent:
        handle = relative(parent.handle, ntpath.basename(path), access=GENERIC_READ | READ_CONTROL | DELETE | SYNCHRONIZE, share=0)
        try:
            private(handle, max_bytes=8192)
            if expected is not None and read_handle(handle, 8192) != expected: raise Unsafe('identity')
            dispose(handle)
        finally: CloseHandle(handle)


def destination(path):
    canonical(path)
    with Directory(ntpath.dirname(path)) as parent:
        try:
            handle = relative(parent.handle, ntpath.basename(path))
        except FileNotFoundError:
            return path
        else:
            CloseHandle(handle)
            raise FileExistsError()


def inspect(path, *, directory=False, limit=512000):
    canonical(path)
    if directory:
        with Directory(path) as parent:
            return private(parent.handle, directory=True)
    with Directory(ntpath.dirname(path)) as parent:
        handle = relative(parent.handle, ntpath.basename(path))
        try:
            return private(handle, max_bytes=limit)
        finally:
            CloseHandle(handle)


def trusted_executable(path):
    """Operator-selected binaries may grant read/execute, never public write."""
    canonical(path)
    privileged = {SID, SYSTEM_SID, 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'}
    with Directory(ntpath.dirname(path), private_leaf=False) as parent:
        handle = relative(parent.handle, ntpath.basename(path), access=GENERIC_READ | READ_CONTROL | SYNCHRONIZE, share=SHARE_READ)
        owner, dacl, descriptor = HANDLE(), HANDLE(), HANDLE()
        try:
            result = info(handle, directory=False)
            check(GetSecurityInfo(handle, 1, 1 | 4, c.byref(owner), None, c.byref(dacl), None, c.byref(descriptor)) == 0)
            if not dacl or sid_text(owner) not in privileged: raise Unsafe('acl')
            acl = c.cast(dacl, c.POINTER(Acl)).contents
            if not 1 <= acl.count <= 64: raise Unsafe('acl')
            for index in range(acl.count):
                ace = HANDLE(); check(GetAce(dacl, index, c.byref(ace)))
                header = c.string_at(ace, 4)
                if header[0] != 0: raise Unsafe('acl')
                if not header[1] & 8 and sid_text(ace.value + 8) not in privileged and c.c_uint32.from_address(ace.value + 4).value & 0x500d0116:
                    raise Unsafe('acl')
            return result
        finally:
            if descriptor: LocalFree(descriptor)
            CloseHandle(handle)


def duplicate_to_parent(handles):
    parent = OpenProcess(0x40, False, os.getppid())
    check(parent)
    copies = []
    try:
        for handle in handles:
            identity = info(handle)['identity']
            copied = HANDLE()
            check(DuplicateHandle(GetCurrentProcess(), handle, parent, c.byref(copied), 0, False, 2))
            copies.append({'handle': copied.value, 'identity': identity})
        return copies
    except BaseException:
        for item in copies:
            DuplicateHandle(parent, item['handle'], None, None, 0, False, 1)
        raise
    finally:
        CloseHandle(parent)


def parent_handles(items):
    if not isinstance(items, list) or not 1 <= len(items) <= 1024:
        raise Unsafe('input')
    seen = set()
    for item in items:
        if not isinstance(item, dict) or set(item) != {'handle', 'identity'} or type(item['handle']) is not int or not 0 < item['handle'] < 2 ** (c.sizeof(HANDLE) * 8):
            raise Unsafe('input')
        identity = item['identity']
        if item['handle'] in seen or not isinstance(identity, list) or len(identity) != 2 or not all(isinstance(x, str) and re.fullmatch(pattern, x) for x, pattern in zip(identity, ('[a-f0-9]{8}', '[a-f0-9]{16}'))):
            raise Unsafe('input')
        seen.add(item['handle'])
    parent = OpenProcess(0x40, False, os.getppid())
    check(parent)
    copies = []
    try:
        for item in items:
            if set(item) != {'handle', 'identity'} or not isinstance(item['handle'], int) or item['handle'] <= 0:
                raise Unsafe('input')
            copied = HANDLE()
            check(DuplicateHandle(parent, item['handle'], GetCurrentProcess(), c.byref(copied), 0, False, 2))
            copies.append(copied.value)
            if info(copied)['identity'] != item['identity']:
                raise Unsafe('identity')
        return parent, copies
    except BaseException as error:
        if isinstance(error, Unsafe): error.unchanged = True
        for handle in copies:
            CloseHandle(handle)
        CloseHandle(parent)
        raise


def close_parent(items, *, lock_digest=None):
    parent, copies = parent_handles(items)
    changed = False
    try:
        if lock_digest is not None:
            private(copies[-1], max_bytes=1024)
            if hashlib.sha256(read_handle(copies[-1], 1024)).hexdigest() != lock_digest:
                raise Unsafe('identity')
            dispose(copies[-1])
        for item in reversed(items):
            changed = True
            check(DuplicateHandle(parent, item['handle'], None, None, 0, False, 1))
    except Unsafe as error:
        # A rejected integrity check has not closed a parent handle. Only that
        # explicit outcome may be retried; an uncertain close must never be.
        if not changed:
            error.unchanged = True
        raise
    finally:
        for handle in reversed(copies):
            CloseHandle(handle)
        CloseHandle(parent)


def pin_database(path, *, create=False):
    canonical(path)
    parent = Directory(ntpath.dirname(path))
    pinned = []
    try:
        for suffix in ('', '-wal', '-shm', '-journal'):
            try:
                handle = relative(parent.handle, ntpath.basename(path) + suffix, access=GENERIC_READ | READ_CONTROL | SYNCHRONIZE)
            except FileNotFoundError:
                continue
            try:
                private(handle)
                if not suffix:
                    pinned.append(handle)
                    handle = None
            finally:
                if handle is not None:
                    CloseHandle(handle)
        if create and not pinned:
            write_new(path, b'')
            handle = relative(parent.handle, ntpath.basename(path), access=GENERIC_READ | READ_CONTROL | SYNCHRONIZE)
            try:
                private(handle)
                pinned.append(handle); handle = None
            finally:
                if handle is not None: CloseHandle(handle)
        return {'path': path, 'handles': duplicate_to_parent(parent.handles + pinned)}
    finally:
        for handle in pinned:
            CloseHandle(handle)
        parent.close()


def dispatch(request):
    schemas = {
        'read': ({'operation','path'}, {'limit','exact'}),
        'write_new': ({'operation','path','data'}, set()),
        'destination': ({'operation','path'}, set()),
        'inspect': ({'operation','path'}, {'directory','limit'}),
        'pin_directory': ({'operation','path'}, {'create'}),
        'pin_database': ({'operation','path'}, {'create'}),
        'lock': ({'operation','path','data'}, set()),
        'close': ({'operation','handles'}, {'digest'}),
    }
    operation = request.get('operation')
    if not isinstance(operation, str) or operation not in schemas: raise Unsafe('input')
    required, optional = schemas[operation]
    if not required <= set(request) or not set(request) <= required | optional: raise Unsafe('input')
    for key in ('create','directory'):
        if key in request and type(request[key]) is not bool: raise Unsafe('input')
    if 'limit' in request and (type(request['limit']) is not int or not 0 <= request['limit'] <= 2**53-1): raise Unsafe('input')
    if 'exact' in request and (type(request['exact']) is not int or not 0 <= request['exact'] <= request.get('limit',16384)): raise Unsafe('input')
    if 'digest' in request and (not isinstance(request['digest'], str) or not re.fullmatch('[a-f0-9]{64}',request['digest'])): raise Unsafe('input')
    if operation == 'read':
        limit = request.get('limit', 16384)
        if type(limit) is not int or not 0 <= limit <= 512000:
            raise Unsafe('input')
        data = read(request['path'], limit=limit, exact=request.get('exact'))
        return {'data': base64.b64encode(data).decode('ascii')}
    if operation == 'write_new':
        write_new(request['path'], base64.b64decode(request['data'], validate=True))
        return {}
    if operation == 'destination':
        return {'path': destination(request['path'])}
    if operation == 'inspect':
        return inspect(request['path'], directory=request.get('directory', False), limit=request.get('limit', 512000))
    if operation == 'pin_directory':
        with Directory(request['path'], create=request.get('create', False)) as parent:
            return {'path': parent.path, 'handles': duplicate_to_parent(parent.handles)}
    if operation == 'pin_database':
        return pin_database(request['path'], create=request.get('create', False))
    if operation == 'lock':
        data = base64.b64decode(request['data'], validate=True)
        if len(data) > 1024:
            raise Unsafe('size')
        parent, handle = write_new(request['path'], data, retain=True)
        try:
            return {'handles': duplicate_to_parent(parent.handles + [handle]), 'digest': hashlib.sha256(data).hexdigest()}
        finally:
            CloseHandle(handle)
            parent.close()
    if operation == 'close':
        close_parent(request['handles'], lock_digest=request.get('digest'))
        return {}
    raise Unsafe('input')


def main():
    try:
        if len(sys.argv) != 3 or sys.argv[1] != '--parent' or int(sys.argv[2]) != os.getppid():
            raise Unsafe('input')
        raw = sys.stdin.buffer.read(800001)
        if len(raw) > 800000: raise Unsafe('input')
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise Unsafe('input')
        print(json.dumps({'ok': True, 'result': dispatch(request)}))
        return 0
    except BaseException as error:
        code = 'exists' if isinstance(error, FileExistsError) else 'missing' if isinstance(error, FileNotFoundError) else error.code if isinstance(error, Unsafe) else 'io'
        print(json.dumps({'ok': False, 'code': code, **({'unchanged': True} if getattr(error, 'unchanged', False) else {})}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
