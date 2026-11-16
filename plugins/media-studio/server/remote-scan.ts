/** Portable traversal with entry and time budgets, including on macOS/BSD hosts. */
export const REMOTE_SCAN = String.raw`
import os, sys, json, time
root, extensions, mode = sys.argv[1:]
extensions = set(json.loads(extensions))
if not os.path.isdir(root):
    raise FileNotFoundError(root)
queue = [(root, 0)]
files = []
seen = 0
truncated = False
deadline = time.monotonic() + 2
for directory, depth in queue:
    if seen >= 20000 or time.monotonic() >= deadline:
        truncated = True
        break
    try:
        with os.scandir(directory) as entries:
            for entry in entries:
                if seen >= 20000 or time.monotonic() >= deadline:
                    truncated = True
                    break
                seen += 1
                if entry.name.startswith('.'):
                    continue
                try:
                    is_dir = entry.is_dir(follow_symlinks=False)
                    if is_dir and mode == 'scan':
                        if depth < 8 and entry.name not in {'node_modules','__pycache__','venv','site-packages','target','Pods'}:
                            queue.append((entry.path, depth + 1))
                        continue
                    ext = entry.name.rsplit('.', 1)[-1].lower()
                    if not is_dir and (ext not in extensions or not entry.is_file()):
                        continue
                    stat = entry.stat()
                    if ext in {'ts','mts'} and not is_dir:
                        if stat.st_size < 16384:
                            continue
                        with open(entry.path, 'rb') as file:
                            head = file.read(389)
                        if not any(len(head) > first + step * 2 and all(head[first + n * step] == 0x47 for n in range(3)) for first, step in ((0,188),(4,192))):
                            continue
                    files.append({'path': entry.path, 'name': entry.name, 'isDirectory': is_dir, 'size': stat.st_size, 'mtimeMs': stat.st_mtime * 1000})
                except OSError:
                    continue
    except OSError:
        continue
print(json.dumps({'files': files, 'truncated': truncated}))
`;
