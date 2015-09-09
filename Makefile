all: hippie.xpi

FILES := \
	install.rdf \
	chrome.manifest \
	prpl.js \
	$(wildcard content/*) \
	${NULL}

hippie.xpi: Makefile

hippie.xpi: ${FILES}
	-rm -f $@
	@zip -r $@ $^

install.rdf: install.rdf.rb
	ruby $< > $@

clean:
	rm -f hippie.xpi install.rdf

# Use in combination with the extension auto-installer extension
install: hippie.xpi
	curl $(if V,--verbose) --header Expect: --data-binary @$< http://localhost:8888/

.PHONY: clean install
