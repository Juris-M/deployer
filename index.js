/*
 * Uploader/downloader for Juris-M release assets
 */

var fs = require("fs");
var path = require("path");
var mm = require("micromatch");
var octokit = require("@octokit/rest")();
var fetch = require("node-fetch");

var config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json")));

/*
 * Utilities
 */

function forceError(txt) {
    console.log("deployer: " + txt);
    process.exit(1);
}

function authenticate () {
    octokit.authenticate({
        type: 'basic',
        username: config.username,
        password: config.password
    })
}

function normalizePath(pth) {
    var demandsDirectory = false;
    var fileName = "";
    if (pth.slice(-1) === path.sep) {
        pth = pth.slice(0, -1);
        demandsDirectory = true;
    }
    if (!fs.existsSync(pth)) {
        if (demandsDirectory) {
            forceError("Path \"" + pth + "\" does not exist");
        } else {
            var pthLst = pth.split(path.sep);
            fileName = pth.slice(-1)[0];
            pth = pth.slice(0, -1).join(path.sep);
            if (!fs.existsSync(pth)) {
                forceError("Parent directory \"" + pth + "\" does not exist");
            }
        }
    }
    return {
        pathName: pth,
        fileName: fileName
}

function getFilePaths(pth, exclude) {
    var stats = fs.lstatSync(pth);
    var files = [];
    var isDirectory = stats.isDirectory();
    if (isDirectory) {
        var lst = fs.readdirSync(pth);
        var excludes = mm(lst, exclude);
        for (var fn of fs.readdirSync(pth)) {
            if (fn.slice(-1)[0] === "~") continue;
            if (excludes.indexOf(path.basename(fn)) > -1) continue;
            files.push(path.join(pth, fn));
        }
    } else if (stats.isFile()) {
        files.push(pth);
    } else {
        forceError("Path " + pth + " is neither file nor directory")
    }
    return {
        fileNames: files,
        isDirectory: isDirectory
    }
}

function getTagPaths(tag) {
    tag = tag.split("/");
    if (tag.length === 1 || (tag.length === 2 && !tag[1])) {
        forceError("Invalid tag \"" + tag.join("/") + "\". Tag must consist of multiple elements separated by /");
    }
    var filename = tag.slice(-1)[0];
    tag = tag.slice(0, -1).join("/");
    return {
        tagName: tag,
        assetName: filename
    }
}

function getValidPaths(argv, exclude, downloadOrder) {
    if (downloadOrder) {
        var pathPos = 1;
        var tagPos = 0;
    } else {
        var pathPos = 0;
        var tagPos = 1;
    }
    var {pathName, fileName} = normalizePath(argv[pathPos]);
    var {fileNames, isDirectory} = getFilePaths(pathName, exclude);
    var {tagName, assetName} = getTagPaths(argv[tagPos]);
    if (isDirectory) {
        if (assetName) {
            forceError("Invalid arguments. Path to directory needs to have tag/ as target (i.e. nothing after the slash)")
        }
        var dirName = pth;
    } else {
        if (fileNames.length !== 1 || !assetName) {
            forceError("Invalid arguments. Path to file needs explicit tag/asset as target");
        }
        if (fileNames[0] && fileName) {
            forceError("Parent of file " + fileName + " is also a file");
        }
        var dirName = path.dirname(pathName);
    }
    return {
        dirName: dirName,
        fileNames: fileNames,
        tagName: tagName,
        assetName: assetName
    }
}

/*
 * Octokit operations
 */

async function getReleaseParams(tagName){
    // Get a release object
    try {
        var release = await octokit.repos.getReleaseByTag({ owner: "Juris-M", repo: "assets", tag: tagName })
        console.log("Release " + tagName + " already exists, reusing");
    } catch(e) {
        console.log("Release " + tagName + " does not yet exist, creating");
        var release = await octokit.repos.createRelease({ owner: "Juris-M", repo: "assets", tag_name: tagName });
    }
    return {
        releaseID: release.data.id,
        uploadTemplate: release.data.upload_url
    }
}

async function getReleaseAssetInfo(releaseID) {
    // Get a list of existing assets
    var ret = [];
    try {
        var assets = await octokit.repos.getAssets({ owner: "Juris-M", repo: "assets", id: releaseID })
    } catch(e) {
        forceError("Unable to acquire assets for release tag " + tag + " for some reason");
    }
    for (var asset of assets.data) {
        ret.push({
            assetID: asset.id,
            assetName: asset.name,
            assetURL: asset.browser_download_url
        })
    }
    return ret;
}

async function pushAssets(releaseID, uploadTemplate, fileNames, assetName) {
    try {
        //var uploadTemplate
        var contentType = "application/octet-stream";
        if (assetName) {
            var fileBuffer = fs.readFileSync(fileNames[0]);
            var fileSize = fs.lstatSync(fileNames[0]).size;
            if (!fileSize) return;
            await octokit.repos.uploadAsset({
                url: uploadTemplate,
                file: fileBuffer,
                contentType: contentType,
                contentLength: fileSize,
                name: assetName
            });
        } else {
            for (var fileName of fileNames) {
                var assetName = path.basename(fileName);
                var fileSize = fs.lstatSync(fileName).size;
                if (!fileSize) continue;
                var fileBuffer = fs.readFileSync(fileName);
                await octokit.repos.uploadAsset({
                    url: uploadTemplate,
                    file: fileBuffer,
                    contentType: contentType,
                    contentLength: fileSize,
                    name: assetName
                });
            }
        }
    } catch(e) {
        forceError("Something when wrong on the way to uploading an asset");
    }
}

async function removeAssets(filePaths, assetInfo) {
    var fileNames = filePaths.map(function(pth){
        return path.basename(pth);
    });
    for (var info of assetInfo) {
        if (fileNames.indexOf(info.assetName) === -1) continue;
        await octokit.repos.deleteAsset({
            owner: "Juris-M",
            repo: "assets",
            id: info.assetID
        });
    }
}

async function fetchAssets(releaseID, dirName, assetName) {
    var assets = await octokit.repos.getAssets({
        owner: "Juris-M",
        repo: "assets",
        id: releaseID
    });
    console.log(JSON.stringify(assets, null, 2))
};

/*
 * Public
 */

async function checkAccess() {
    try {
        var result = await octokit.authorization.getAll({
            page: 1,
            per_page: 1
        })
    } catch(e) {
        forceError("Something went wrong with authorization");
    }
    console.log("deployer: repo access OK");
    process.exit(0);
}

async function upload(argv, exclude) {
    var {fileNames, tagName, assetName} = getValidPaths(argv, exclude);
    var {releaseID, uploadTemplate} = await getReleaseParams(tagName);
    var assetInfo = await getReleaseAssetInfo(releaseID);

    // Remove assets that have the same name as one of our upload files
    await removeAssets(fileNames, assetInfo);

    // Push our files into the release
    await pushAssets(releaseID, uploadTemplate, fileNames, assetName)

    // Done!
    console.log("Done!");
}

async function download(argv) {
    var {dirName, fileNames, tagName, assetName} = getValidPaths(argv, null, true);
    var {releaseID, uploadTemplate} = await getReleaseParams(tagName);
    var assetInfo = await getReleaseAssetInfo(releaseID);

    // Download all assets in the target release
    for (var info of assetInfo) {
        var res = await fetch(info.assetURL);
        var txt = await res.text();
        fs.writeFileSync(path.join(dirName, info.assetName), txt);
    }
}

var opt = require('node-getopt').create([
  ['u' 		, 'upload',   'Upload. Second argument assumed to be tag.'],
  ['d' 		, 'download', 'Download. First argument assumed to be tag/ or tag/asset.'],
  ['x' 		, 'exclude=ARG+',  'Exclude. Ignore files matching glob. Multiple instances allowed. Valid only with -u option.'],
  ['v' 		, 'validate', 'Validate. Check access. Assumes no arguments.'],
  ['h' 		, 'help'                , 'display this help']
])              // create Getopt instance
.bindHelp()     // bind option 'help' to default action
.parseSystem(); // parse command line

var opt_count = 0;
for (var o of ["download", "upload", "validate"]) {
    if (opt.options[o]) {
        opt_count++;
    }
}

if (opt_count > 1) {
    console.log("Can only select one of -d, -u or -v");
    process.exit();
}

if (opt_count === 0) {
    console.log("Must select one of -d, -u or -v");
    process.exit();
}

if (opt.options.exclude && !opt.options.upload) {
    console.log("The -x option is available only with -u")
    process.exit();
}

authenticate();

if (opt.options.validate) {
    checkAccess()
}

if (opt.options.upload || opt.options.download) {
    if (opt.argv.length !== 2) {
        forceError("Exactly two arguments are required with the -u option")
    }
    if (opt.options.upload) {
        upload(opt.argv, opt.options.exclude)
    } else {
        download(opt.argv)
    }
}
