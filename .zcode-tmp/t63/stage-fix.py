import pathlib, subprocess, difflib
root=pathlib.Path.cwd()
changes={
'NoteList':[
('  worldviewCategory?: string;','  worldviewCategory?: string;\n  onWorldviewCategoryChange?: (category: string) => void;'),
('  worldviewCategory,\n','  worldviewCategory,\n  onWorldviewCategoryChange,\n'),
('  const [categoryFilter, setCategoryFilter] = useState(worldviewCategory ?? "");','  const categoryFilter = kind === "世界观" ? worldviewCategory ?? "" : "";'),
('setCategoryFilter("")','onWorldviewCategoryChange?.("")'),
('setCategoryFilter(POWER_SYSTEM_CATEGORY)','onWorldviewCategoryChange?.(POWER_SYSTEM_CATEGORY)')],
'ProjectPage':[
('const [powerSystemView, setPowerSystemView] = useState(false);','const [worldviewCategory, setWorldviewCategory] = useState("");'),
('setPowerSystemView(false);','setWorldviewCategory("");'),
('setPowerSystemView(true);','setWorldviewCategory("力量体系");'),
('worldviewCategory={tab === "世界观" && powerSystemView ? "力量体系" : undefined}','worldviewCategory={tab === "世界观" ? worldviewCategory : undefined}\n              onWorldviewCategoryChange={setWorldviewCategory}')]
}
for name,replacements in changes.items():
    path='app/src/'+name+'.tsx'; old=subprocess.check_output(['git','show','HEAD:'+path]).decode('utf-8').replace('\r\n','\n'); new=old
    for a,b in replacements:
        assert new.count(a)==1,(name,a); new=new.replace(a,b,1)
    patch=''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='a/'+path,tofile='b/'+path))
    (root/'.zcode-tmp/t63'/f'{name}.fix.patch').write_text(patch,encoding='utf-8')
