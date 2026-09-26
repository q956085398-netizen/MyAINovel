import difflib, pathlib, subprocess
root = pathlib.Path.cwd()
for name in ['NoteList','ProjectPage']:
    path = 'app/src/'+name+'.tsx'
    before = (root/'.zcode-tmp/t63'/f'{name}.before.tsx').read_text(encoding='utf-8').splitlines(True)
    after = (root/path).read_text(encoding='utf-8').splitlines(True)
    base = subprocess.check_output(['git','show','HEAD:'+path]).decode('utf-8').replace('\r\n','\n')
    for op,a,b,c,d in difflib.SequenceMatcher(None,before,after,autojunk=False).get_opcodes():
        if op == 'equal': continue
        old,new = ''.join(before[a:b]),''.join(after[c:d])
        if old:
            if base.count(old)!=1: raise Exception(f'{name}: old block not unique: {old!r}')
            base = base.replace(old,new,1)
        else:
            placed=False
            for size in [4,3,2,1]:
                prev=''.join(before[max(0,a-size):a])
                next=''.join(before[a:a+size])
                if prev.strip() and base.count(prev)==1:
                    base=base.replace(prev,prev+new,1); placed=True; break
                if next.strip() and base.count(next)==1:
                    base=base.replace(next,new+next,1); placed=True; break
            if not placed: raise Exception(f'{name}: insertion lacks anchor: {new!r}')
    if name=='ProjectPage':
        base=base.replace('const TABS = [\n','const TABS = [\n  "首页",\n',1)
        base=base.replace('const NAV_GROUPS = [\n','const NAV_GROUPS = [\n  { step: "", label: "", tabs: ["首页"] },\n',1)
    (root/'.zcode-tmp/t63'/f'{name}.staged.tsx').write_text(base,encoding='utf-8',newline='\n')
    patch=''.join(difflib.unified_diff(subprocess.check_output(['git','show','HEAD:'+path]).decode('utf-8').replace('\r\n','\n').splitlines(True),base.splitlines(True),fromfile='a/'+path,tofile='b/'+path))
    (root/'.zcode-tmp/t63'/f'{name}.stage.patch').write_text(patch,encoding='utf-8',newline='\n')
