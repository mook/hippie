#!/usr/bin/env ruby

puts %Q{
<?xml version="1.0" encoding="utf-8"?>
<RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:em="http://www.mozilla.org/2004/em-rdf#">
  <Description about="urn:mozilla:install-manifest">
    <em:id>hippie@mook.github.io</em:id>
    <em:version>0.0.0.#{Time.now.utc.strftime '%Y%m%d'}.#{Time.now.utc.to_i}</em:version>
    <em:type>2</em:type>
    <em:unpack>false</em:unpack>

    <em:targetApplication>
      <Description>
        <!-- Thunderbird -->
        <em:id>{3550f703-e582-4d05-9a08-453d09bdfdc6}</em:id>
        <em:minVersion>36.0</em:minVersion>
        <em:maxVersion>*</em:maxVersion>
      </Description>
    </em:targetApplication>

    <em:targetApplication>
      <Description>
        <!-- Instantbird -->
        <em:id>{33cb9019-c295-46dd-be21-8c4936574bee}</em:id>
        <em:minVersion>1.5</em:minVersion>
        <em:maxVersion>*</em:maxVersion>
      </Description>
    </em:targetApplication>

    <em:name>Hippie</em:name>
    <em:description>HipChat protocol for Thunderbird/Instantbird</em:description>
    <em:creator>Mook</em:creator>
  </Description>
</RDF>
}.strip
