#!/usr/bin/env ruby

require 'digest'
require 'fileutils'
require 'open3'
require 'rbconfig'
require 'tmpdir'
require 'yaml'

class VerifyDesktopUpdaterMetadataTest
  SCRIPT = File.expand_path('verify-desktop-updater-metadata.rb', __dir__)
  VERSION = '1.2.3'

  FORMATS = {
    'desktop.dmg' => ['dmg-x64', 'mac:x64'],
    'desktop.zip' => ['zip-x64', 'mac:x64'],
    'desktop.exe' => ['windows-x64', 'windows:x64'],
    'desktop.AppImage' => ['appimage-x64', 'appimage:x64'],
    'desktop.deb' => ['deb-x64', 'deb:x64'],
  }.freeze

  def install_fake_tools(bin_dir)
    dispatcher = File.join(bin_dir, 'fake_tool.rb')
    File.write(dispatcher, <<~'RUBY')
      require 'fileutils'

      tool = ARGV.shift
      describe = lambda do |path|
        format, architecture = File.read(path).strip.split(':', 2)
        machine = architecture == 'arm64' ? 'Aarch64' : 'x86-64'
        case format
        when 'mac' then "Mach-O 64-bit #{architecture == 'arm64' ? 'arm64' : 'x86_64'} executable"
        when 'windows' then "PE32+ executable (GUI) #{machine}, for MS Windows"
        when 'appimage', 'deb' then "ELF 64-bit LSB pie executable, #{machine}, dynamically linked"
        else 'ASCII text'
        end
      end
      extract_app = lambda do |archive, directory|
        executable = File.join(directory, 'Standard Red Notes.app', 'Contents', 'MacOS', 'standard-red-notes')
        FileUtils.mkdir_p(File.dirname(executable))
        FileUtils.cp(archive, executable)
      end

      case tool
      when 'file'
        puts describe.call(ARGV.last)
      when 'unzip'
        extract_app.call(ARGV.fetch(1), ARGV.fetch(ARGV.index('-d') + 1))
      when '7z'
        output = ARGV.find { |argument| argument.start_with?('-o') }.delete_prefix('-o')
        extract_app.call(ARGV.last, output)
      when 'dpkg-deb'
        if ARGV.first == '-f'
          _format, architecture = File.read(ARGV.fetch(1)).strip.split(':', 2)
          puts architecture == 'arm64' ? 'arm64' : 'amd64'
        elsif ARGV.first == '-x'
          executable = File.join(ARGV.fetch(2), 'usr', 'bin', 'standard-red-notes')
          FileUtils.mkdir_p(File.dirname(executable))
          FileUtils.cp(ARGV.fetch(1), executable)
        else
          abort "unexpected dpkg-deb invocation: #{ARGV.join(' ')}"
        end
      else
        abort "unknown fake tool: #{tool}"
      end
    RUBY

    %w[file unzip 7z dpkg-deb].each do |tool|
      unix_wrapper = File.join(bin_dir, tool)
      File.write(unix_wrapper, <<~RUBY)
        #!/usr/bin/env ruby
        ARGV.unshift(#{tool.inspect})
        load File.expand_path('fake_tool.rb', __dir__)
      RUBY
      File.chmod(0o755, unix_wrapper)
      File.write(File.join(bin_dir, "#{tool}.cmd"), "@echo off\r\nruby \"%~dp0fake_tool.rb\" #{tool} %*\r\n")
    end
  end

  def with_fixture(assets = FORMATS)
    Dir.mktmpdir('srn-updater-contract-') do |root|
      source_dir = File.join(root, 'source')
      bin_dir = File.join(root, 'bin')
      FileUtils.mkdir_p([source_dir, bin_dir])
      install_fake_tools(bin_dir)
      assets.each { |name, (_kind, marker)| File.write(File.join(source_dir, name), marker) }
      yield root, source_dir, bin_dir
    end
  end

  def metadata_document(source_dir, assets, legacy: false)
    files = assets.map do |name, (_kind, _marker)|
      path = File.join(source_dir, name)
      {
        'url' => name,
        'size' => File.size(path),
        'sha512' => [Digest::SHA512.file(path).digest].pack('m0'),
      }
    end
    document = { 'version' => VERSION, 'files' => files }
    if legacy
      first = files.first
      document.merge!('path' => first.fetch('url'), 'size' => first.fetch('size'), 'sha512' => first.fetch('sha512'))
    end
    document
  end

  def run_verifier(source_dir, bin_dir, assets, document)
    metadata = File.join(source_dir, 'latest.yml')
    File.write(metadata, YAML.dump(document))
    arguments = [
      '--metadata', metadata,
      '--source-dir', source_dir,
      '--expected-version', VERSION,
      *assets.keys.flat_map { |name| ['--allow', name] },
      *assets.flat_map { |name, (kind, _marker)| ['--architecture', "#{name}=#{kind}"] },
    ]
    environment = { 'PATH' => "#{bin_dir}#{File::PATH_SEPARATOR}#{ENV.fetch('PATH', '')}" }
    Open3.capture3(environment, RbConfig.ruby, SCRIPT, *arguments)
  end

  def assert_contract_failure(status, stderr, message = nil)
    refute status.success?, message
    assert_includes stderr, 'desktop updater contract:', message
  end

  def assert(condition, message = 'assertion failed')
    raise message unless condition
  end

  def refute(condition, message = 'refutation failed')
    raise message if condition
  end

  def assert_includes(haystack, needle, message = nil)
    assert(haystack.include?(needle), message || "Expected #{haystack.inspect} to include #{needle.inspect}")
  end

  def assert_match(pattern, value, message = nil)
    assert(value.match?(pattern), message || "Expected #{value.inspect} to match #{pattern.inspect}")
  end

  def test_accepts_modern_metadata_for_every_supported_installer_format
    with_fixture do |_root, source_dir, bin_dir|
      stdout, stderr, status = run_verifier(source_dir, bin_dir, FORMATS, metadata_document(source_dir, FORMATS))
      assert status.success?, stderr
      assert_includes stdout, '5 updater entries and 5 installer architectures'
    end
  end

  def test_accepts_matching_legacy_fields
    assets = { 'desktop.exe' => FORMATS.fetch('desktop.exe') }
    with_fixture(assets) do |_root, source_dir, bin_dir|
      _stdout, stderr, status = run_verifier(source_dir, bin_dir, assets, metadata_document(source_dir, assets, legacy: true))
      assert status.success?, stderr
    end
  end

  def test_rejects_non_basename_urls
    assets = { 'desktop.exe' => FORMATS.fetch('desktop.exe') }
    with_fixture(assets) do |_root, source_dir, bin_dir|
      document = metadata_document(source_dir, assets)
      document.fetch('files').first['url'] = '../desktop.exe'
      _stdout, stderr, status = run_verifier(source_dir, bin_dir, assets, document)
      assert_contract_failure(status, stderr)
      assert_includes stderr, 'relative basename'
    end
  end

  def test_rejects_wrong_size
    assets = { 'desktop.exe' => FORMATS.fetch('desktop.exe') }
    with_fixture(assets) do |_root, source_dir, bin_dir|
      document = metadata_document(source_dir, assets)
      document.fetch('files').first['size'] += 1
      _stdout, stderr, status = run_verifier(source_dir, bin_dir, assets, document)
      assert_contract_failure(status, stderr)
      assert_includes stderr, 'invalid updater size'
    end
  end

  def test_rejects_wrong_sha512
    assets = { 'desktop.exe' => FORMATS.fetch('desktop.exe') }
    with_fixture(assets) do |_root, source_dir, bin_dir|
      document = metadata_document(source_dir, assets)
      document.fetch('files').first['sha512'] = ['wrong'].pack('m0')
      _stdout, stderr, status = run_verifier(source_dir, bin_dir, assets, document)
      assert_contract_failure(status, stderr)
      assert_includes stderr, 'SHA-512 mismatch'
    end
  end

  def test_rejects_wrong_architecture_for_every_supported_format
    FORMATS.each do |name, (kind, marker)|
      wrong_marker = marker.sub(':x64', ':arm64')
      assets = { name => [kind, wrong_marker] }
      with_fixture(assets) do |_root, source_dir, bin_dir|
        _stdout, stderr, status = run_verifier(source_dir, bin_dir, assets, metadata_document(source_dir, assets))
        assert_contract_failure(status, stderr, "#{name} should reject the opposite architecture")
        assert_match(/wrong architecture|opposite architecture|declares Debian architecture/, stderr, name)
      end
    end
  end

  def test_rejects_binary_content_that_does_not_match_the_declared_format
    FORMATS.each do |name, (kind, _marker)|
      assets = { name => [kind, 'plain:x64'] }
      with_fixture(assets) do |_root, source_dir, bin_dir|
        _stdout, stderr, status = run_verifier(source_dir, bin_dir, assets, metadata_document(source_dir, assets))
        assert_contract_failure(status, stderr, "#{name} should reject the wrong binary format")
      end
    end
  end
end


if $PROGRAM_NAME == __FILE__
  suite = VerifyDesktopUpdaterMetadataTest.new
  tests = suite.public_methods.grep(/^test_/).sort
  failures = []
  tests.each do |test|
    suite.public_send(test)
    puts("PASS #{test}")
  rescue StandardError => error
    failures << [test, error]
    warn("FAIL #{test}: #{error.message}")
  end
  puts("#{tests.length} tests, #{failures.length} failures")
  exit(1) unless failures.empty?
end
