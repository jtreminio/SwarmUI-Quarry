#!/usr/bin/env python3
"""Benchmark the built C# backend and actual sampler against two independent copies.

Run ./run-tests first, then pass its output directory with --assemblies. This builds
only a small benchmark executable against those binaries; it does not rebuild SwarmUI.
The root must contain baseline.lance and optimized.lance with identical logical rows.
"""
import argparse
from pathlib import Path
import shutil
import subprocess
from xml.sax.saxutils import escape

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('root', type=Path)
parser.add_argument('--assemblies', required=True, type=Path)
parser.add_argument('--output', type=Path, default=Path('.cache/benchmarks/casing-production-reads.json'))
args = parser.parse_args()
repo = Path(__file__).resolve().parents[2]
work = repo / '.cache/benchmarks/casing-reader'
work.mkdir(parents=True, exist_ok=True)
assembly = escape(str(args.assemblies.resolve()))
(work / 'reader.csproj').write_text(f'''<Project Sdk="Microsoft.NET.Sdk">
<PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><AssemblyName>SwarmUI-Quarry.Tests</AssemblyName></PropertyGroup>
<ItemGroup><FrameworkReference Include="Microsoft.AspNetCore.App" />
<Reference Include="{assembly}/*.dll" Exclude="{assembly}/SwarmUI-Quarry.Tests.dll" />
<None Include="{assembly}/runtimes/linux-x64/native/libduckdb.so" Link="libduckdb.so" CopyToOutputDirectory="PreserveNewest" />
</ItemGroup></Project>''')
shutil.copyfile(Path(__file__).with_name('casing_reads.cs.txt'), work / 'Program.cs')
args.output.parent.mkdir(parents=True, exist_ok=True)
subprocess.run(['dotnet', 'run', '--project', str(work / 'reader.csproj'), '--',
                str(args.root.resolve()), str(args.output.resolve()), str(repo)], check=True)
