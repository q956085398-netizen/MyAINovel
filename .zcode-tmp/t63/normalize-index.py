import subprocess
for path in ['app/src/NoteList.tsx','app/src/ProjectPage.tsx']:
    raw=subprocess.check_output(['git','show','HEAD:'+path]).replace(b'\r\n',b'\n')
    oid=subprocess.check_output(['git','hash-object','-w','--stdin'],input=raw).decode().strip()
    subprocess.check_call(['git','update-index','--cacheinfo','100644',oid,path])
