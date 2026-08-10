#!/usr/bin/env ruby

require 'date'
require 'digest'
require 'fileutils'
require 'open3'
require 'optparse'
require 'pathname'
require 'tmpdir'
require 'uri'
require 'yaml'

options = { allowed: [], architectures: [] }
DMG_EXECUTABLE_SELECTOR = '-ir!*.app/Contents/MacOS/*'
OptionParser.new do |parser|
  parser.on('--metadata PATH') { |value| options[:metadata] = value }
  parser.on('--source-dir PATH') { |value| options[:source_dir] = value }
  parser.on('--expected-version VERSION') { |value| options[:expected_version] = value }
  parser.on('--allow NAME') { |value| options[:allowed] << value }
  parser.on('--architecture NAME=KIND') { |value| options[:architectures] << value }
end.parse!

def fail_contract(message)
  warn("desktop updater contract: #{message}")
  exit(1)
end

def command!(*command)
  stdout, stderr, status = Open3.capture3(*command)
  fail_contract("#{command.join(' ')} failed: #{stderr.strip}") unless status.success?
  stdout
end

def updater_basename(raw_url)
  uri = URI.parse(raw_url)
  fail_contract("updater URL must be a relative basename: #{raw_url}") if uri.scheme || uri.host || uri.query || uri.fragment
  decoded = URI.decode_www_form_component(uri.path)
  fail_contract("updater URL must be a relative basename: #{raw_url}") unless decoded == File.basename(decoded) && !decoded.empty?
  decoded
rescue URI::InvalidURIError
  fail_contract("invalid updater URL: #{raw_url}")
end

def verify_sha512_and_size!(entry, source_dir, allowed)
  fail_contract('every updater file entry must be a mapping') unless entry.is_a?(Hash)
  name = updater_basename(String(entry.fetch('url')))
  fail_contract("undeclared updater asset: #{name}") unless allowed.include?(name)
  path = File.join(source_dir, name)
  fail_contract("missing updater asset: #{name}") unless File.file?(path) && File.size(path).positive?
  size = Integer(entry.fetch('size').to_s, 10)
  fail_contract("invalid updater size for #{name}") unless size.positive? && File.size(path) == size
  declared = String(entry.fetch('sha512'))
  actual = [Digest::SHA512.file(path).digest].pack('m0')
  fail_contract("SHA-512 mismatch for #{name}") unless declared == actual
  [name, declared, size]
rescue KeyError, ArgumentError => error
  fail_contract("invalid updater file entry: #{error.message}")
end

def file_description(path)
  command!('file', '-b', path).strip
end

def require_architecture!(description, expected, name)
  pattern = case expected
            when 'x64' then /(x86-64|x86_64|amd64)/i
            when 'arm64' then /(aarch64|arm64|ARM64)/i
            else fail_contract("unknown architecture #{expected} for #{name}")
            end
  fail_contract("#{name} has wrong architecture: #{description}") unless description.match?(pattern)
  opposite = expected == 'x64' ? /(aarch64|arm64)/i : /(x86-64|x86_64|amd64)/i
  fail_contract("#{name} contains the opposite architecture: #{description}") if description.match?(opposite)
end

def require_format!(description, pattern, format, name)
  fail_contract("#{name} is not an inspectable #{format} executable: #{description}") unless description.match?(pattern)
end

def app_executable!(directory, name)
  candidates = Dir.glob(File.join(directory, '**', '*.app', 'Contents', 'MacOS', '*'), File::FNM_DOTMATCH)
                  .select do |candidate|
                    relative = Pathname.new(candidate).relative_path_from(Pathname.new(directory)).to_s
                    File.file?(candidate) && relative.scan(/\.app[\\\/]/).length == 1
                  end
  fail_contract("#{name} must contain exactly one app executable, found #{candidates.length}") unless candidates.one?
  candidates.first
end

def normalized_relative_path(directory, candidate)
  Pathname.new(candidate).relative_path_from(Pathname.new(directory)).to_s.tr('\\', '/')
end

def verify_pe32_plus_machine!(path, expected, name)
  expected_machine = case expected
                     when 'x64' then 0x8664
                     when 'arm64' then 0xaa64
                     else fail_contract("unknown architecture #{expected} for #{name}")
                     end

  File.open(path, 'rb') do |file|
    fail_contract("#{name} payload is not a valid PE executable") unless file.read(2) == 'MZ'
    file.seek(0x3c)
    offset_bytes = file.read(4)
    fail_contract("#{name} payload has a truncated PE header") unless offset_bytes&.bytesize == 4
    pe_offset = offset_bytes.unpack1('V')
    fail_contract("#{name} payload has an invalid PE header offset") if pe_offset < 0x40 || pe_offset > File.size(path) - 26
    file.seek(pe_offset)
    fail_contract("#{name} payload is not a valid PE executable") unless file.read(4) == "PE\0\0"
    machine_bytes = file.read(2)
    fail_contract("#{name} payload has a truncated PE machine field") unless machine_bytes&.bytesize == 2
    machine = machine_bytes.unpack1('v')
    file.seek(pe_offset + 24)
    magic_bytes = file.read(2)
    fail_contract("#{name} payload has a truncated PE optional header") unless magic_bytes&.bytesize == 2
    optional_magic = magic_bytes.unpack1('v')
    fail_contract("#{name} payload is not PE32+") unless optional_magic == 0x20b
    unless machine == expected_machine
      fail_contract(format('%s payload has wrong architecture: PE machine 0x%04x, expected 0x%04x', name, machine,
                           expected_machine))
    end
  end
rescue Errno::EACCES, Errno::ENOENT, Errno::EINVAL => error
  fail_contract("could not inspect #{name} payload PE header: #{error.message}")
end

def verify_architecture!(path, kind, name)
  format, expected = kind.split('-', 2)
  fail_contract("invalid architecture kind for #{name}: #{kind}") unless format && expected
  case format
  when 'windows'
    launcher = file_description(path)
    require_format!(launcher, /PE32.*Nullsoft Installer/i, 'NSIS launcher', name)
    payload_name = expected == 'x64' ? 'app-64.7z' : 'app-arm64.7z'
    expected_payload_path = "$PLUGINSDIR/#{payload_name}"
    Dir.mktmpdir('srn-updater-windows-installer-') do |installer_directory|
      command!('7z', 'x', '-y', "-o#{installer_directory}", path)
      payloads = Dir.glob(File.join(installer_directory, '**', '*'), File::FNM_DOTMATCH)
                    .select { |candidate| File.file?(candidate) }
                    .map { |candidate| [candidate, normalized_relative_path(installer_directory, candidate)] }
                    .select { |_candidate, relative| File.basename(relative).match?(%r{\Aapp-[^/]+\.7z\z}) }
      payload_paths = payloads.map(&:last).sort
      unless payload_paths == [expected_payload_path]
        found = payload_paths.empty? ? 'none' : payload_paths.join(', ')
        fail_contract("#{name} has wrong architecture payload: found #{found}, expected #{expected_payload_path}")
      end
      Dir.mktmpdir('srn-updater-windows-payload-') do |payload_directory|
        command!('7z', 'x', '-y', "-o#{payload_directory}", payloads.first.first)
        executable_names = Dir.children(payload_directory).select do |entry|
          candidate = File.join(payload_directory, entry)
          File.file?(candidate) && File.extname(entry).casecmp?('.exe')
        end.sort
        unless executable_names == ['Standard Red Notes.exe']
          found = executable_names.empty? ? 'none' : executable_names.join(', ')
          fail_contract("#{name} payload has wrong top-level application executables: found #{found}, " \
                        'expected Standard Red Notes.exe')
        end
        verify_pe32_plus_machine!(File.join(payload_directory, executable_names.first), expected, name)
      end
    end
  when 'appimage'
    description = file_description(path)
    require_format!(description, /ELF 64-bit/i, 'ELF', name)
    require_architecture!(description, expected, name)
  when 'zip'
    Dir.mktmpdir('srn-updater-zip-') do |directory|
      command!('unzip', '-q', path, '-d', directory)
      description = file_description(app_executable!(directory, name))
      require_format!(description, /Mach-O 64-bit/i, 'Mach-O', name)
      require_architecture!(description, expected, name)
    end
  when 'dmg'
    Dir.mktmpdir('srn-updater-dmg-') do |directory|
      command!('7z', 'x', '-y', DMG_EXECUTABLE_SELECTOR, "-o#{directory}", path)
      description = file_description(app_executable!(directory, name))
      require_format!(description, /Mach-O 64-bit/i, 'Mach-O', name)
      require_architecture!(description, expected, name)
    end
  when 'deb'
    declared = command!('dpkg-deb', '-f', path, 'Architecture').strip
    expected_deb = expected == 'x64' ? 'amd64' : 'arm64'
    fail_contract("#{name} declares Debian architecture #{declared}, expected #{expected_deb}") unless declared == expected_deb
    Dir.mktmpdir('srn-updater-deb-') do |directory|
      command!('dpkg-deb', '-x', path, directory)
      executables = Dir.glob(File.join(directory, '**', '*')).select do |candidate|
        File.file?(candidate) && file_description(candidate).match?(/ELF 64-bit.*(executable|shared object)/i)
      end
      fail_contract("#{name} contains no inspectable ELF executable") if executables.empty?
      executables.each { |candidate| require_architecture!(file_description(candidate), expected, name) }
    end
  else
    fail_contract("unsupported architecture format #{format} for #{name}")
  end
end

%i[metadata source_dir expected_version].each do |key|
  fail_contract("missing --#{key.to_s.tr('_', '-')}") if options[key].to_s.empty?
end
fail_contract('at least one --allow is required') if options[:allowed].empty?
fail_contract('--allow values must be unique basenames') unless options[:allowed].uniq.length == options[:allowed].length &&
                                                         options[:allowed].all? { |name| name == File.basename(name) && !name.empty? }

metadata_path = File.expand_path(options[:metadata])
source_dir = File.expand_path(options[:source_dir])
fail_contract('metadata must be inside source-dir') unless Pathname.new(metadata_path).dirname == Pathname.new(source_dir)
document = YAML.safe_load(File.read(metadata_path), permitted_classes: [Date, Time], aliases: false)
fail_contract('metadata root must be a mapping') unless document.is_a?(Hash)
fail_contract('metadata version mismatch') unless String(document.fetch('version')) == options[:expected_version]

files = document.fetch('files')
fail_contract('metadata files must be a nonempty array') unless files.is_a?(Array) && !files.empty?
verified = files.map { |entry| verify_sha512_and_size!(entry, source_dir, options[:allowed]) }
names = verified.map(&:first)
fail_contract('metadata contains duplicate updater basenames') unless names.uniq.length == names.length

legacy_path = document['path']
legacy_sha512 = document['sha512']
if legacy_path || legacy_sha512
  fail_contract('legacy path and sha512 must appear together') unless legacy_path && legacy_sha512
  legacy_name = updater_basename(String(legacy_path))
  match = verified.find { |name, sha512, _size| name == legacy_name && sha512 == String(legacy_sha512) }
  fail_contract('legacy path/sha512 must match one fully verified files entry') unless match
  if document.key?('size')
    fail_contract('legacy size must match the verified files entry') unless Integer(document['size'].to_s, 10) == match[2]
  end
end

architecture_names = options[:architectures].map { |specification| specification.split('=', 2).first }
installer_names = options[:allowed].select { |name| name.match?(/\.(?:dmg|zip|exe|AppImage|deb)\z/) }
fail_contract('every declared installer must have exactly one architecture contract') unless architecture_names.sort == installer_names.sort

options[:architectures].each do |specification|
  name, kind = specification.split('=', 2)
  fail_contract("invalid --architecture #{specification}") unless name && kind && options[:allowed].include?(name)
  path = File.join(source_dir, name)
  fail_contract("missing architecture asset: #{name}") unless File.file?(path) && File.size(path).positive?
  verify_architecture!(path, kind, name)
end

puts("Verified #{File.basename(metadata_path)}: #{verified.length} updater entries and #{options[:architectures].length} installer architectures")
