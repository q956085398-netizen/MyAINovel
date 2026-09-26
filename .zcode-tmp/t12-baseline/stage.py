import difflib, pathlib, subprocess
root=pathlib.Path.cwd()
for name in ['NoteList.tsx','ProjectPage.tsx','types.ts']:
    path='app/src/'+name
    before=(root/'.zcode-tmp/t12-baseline'/name).read_text(encoding='utf-8').splitlines(True)
    after=(root/path).read_text(encoding='utf-8').splitlines(True)
    head=subprocess.check_output(['git','show','HEAD:'+path]).decode('utf-8').replace('\r\n','\n')
    base=head
    for op,a,b,c,d in difflib.SequenceMatcher(None,before,after,autojunk=False).get_opcodes():
        if op=='equal': continue
        old,new=''.join(before[a:b]),''.join(after[c:d])
        if old:
            old=old.replace('小传＋关系＋读者遐想（类型圈）当人格底座','小传＋关系＋类型圈当人格底座')
            if base.count(old)!=1: raise Exception(f'{name}: old block not unique: {old!r}')
            base=base.replace(old,new,1)
        else:
            placed=False
            for size in [4,3,2,1]:
                prev=''.join(before[max(0,a-size):a]);nxt=''.join(before[a:a+size])
                if prev.strip() and base.count(prev)==1:
                    base=base.replace(prev,prev+new,1);placed=True;break
                if nxt.strip() and base.count(nxt)==1:
                    base=base.replace(nxt,new+nxt,1);placed=True;break
            if not placed:raise Exception(f'{name}: insertion lacks anchor')
    patch=''.join(difflib.unified_diff(head.splitlines(True),base.splitlines(True),fromfile='a/'+path,tofile='b/'+path))
    target=root/'.zcode-tmp/t12-baseline'/f'{name}.patch'
    target.write_text(patch,encoding='utf-8',newline='\n')
    subprocess.run(['git','apply','--cached',str(target)],check=True)
