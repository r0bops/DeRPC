// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IOperatorRegistry {
    function register(string calldata label, address owner, address subregistry, address resolver, uint256 roleBitmap, uint64 expiry) external returns (uint256);
    function renew(uint256 anyId, uint64 expiry) external;
}

/// @notice Curated, free registration. No stake or deposit. Fixed-size entries are storage-provable.
/// Grant this contract ROLE_REGISTRAR and ROLE_RENEW only; no person needs ROLE_UNREGISTER.
contract OperatorRegistrar {
    struct Operator {
        bytes32 label;       // slot 0 within entry: ASCII label, right-padded, 1..31 bytes
        address operator;   // slot 1: low 160 bits
        uint64 expiry;      // slot 1: next 64 bits, effective listing expiry
        bool active;        // slot 1: next 8 bits
        address payee;      // slot 2: low 160 bits; authenticated payment destination
    }

    // Layout is a public protocol: length at slot 0, entries at keccak256(uint256(0)), stride 3.
    Operator[] public operators;
    mapping(bytes32 => uint256) private indexPlusOne;
    IOperatorRegistry public immutable registry;
    address public immutable curator;
    uint256 public constant MAX_OPERATORS = 128;
    uint64 public constant MAX_LEASE = 30 days;

    event Listed(uint256 indexed index, bytes32 indexed label, address operator, address payee, uint64 expiry);
    event Removed(uint256 indexed index);
    event Renewed(uint256 indexed index, uint64 expiry);
    event PayeeChanged(uint256 indexed index, address payee);
    error Unauthorized();
    error InvalidOperator();

    constructor(IOperatorRegistry registry_, address curator_) {
        if (address(registry_).code.length == 0 || curator_ == address(0)) revert InvalidOperator();
        registry = registry_;
        curator = curator_;
    }

    function register(string calldata label, address operator, address resolver, address payee, uint64 expiry) external returns (uint256 index) {
        if (msg.sender != curator) revert Unauthorized();
        bytes memory raw = bytes(label);
        if (raw.length == 0 || raw.length > 31 || operator == address(0) || resolver.code.length == 0 || payee == address(0)) revert InvalidOperator();
        for (uint256 i; i < raw.length; ++i) {
            bytes1 c = raw[i];
            if (!(c >= 0x61 && c <= 0x7a || c >= 0x30 && c <= 0x39 || c == 0x2d && i != 0 && i + 1 != raw.length)) revert InvalidOperator();
        }
        _validExpiry(expiry);
        bytes32 packed;
        assembly { packed := mload(add(raw, 32)) }
        uint256 existing = indexPlusOne[packed];
        if (existing == 0) {
            if (operators.length >= MAX_OPERATORS) revert InvalidOperator();
            index = operators.length;
            operators.push(Operator(packed, operator, expiry, true, payee));
            indexPlusOne[packed] = index + 1;
        } else {
            index = existing - 1;
            if (operators[index].expiry > block.timestamp) revert InvalidOperator();
            operators[index] = Operator(packed, operator, expiry, true, payee);
        }
        // No transfer, resolver-change or subregistry role is granted to the name owner.
        // Each operator controls only its own resolver's limited text-key role separately.
        registry.register(label, operator, address(0), resolver, 0, expiry);
        emit Listed(index, packed, operator, payee, expiry);
    }

    function renew(uint256 index, uint64 expiry) external {
        Operator storage op = operators[index];
        if (msg.sender != curator && msg.sender != op.operator) revert Unauthorized();
        if (!op.active || expiry <= op.expiry) revert InvalidOperator();
        _validExpiry(expiry);
        op.expiry = expiry;
        registry.renew(uint256(keccak256(bytes(_label(op.label)))), expiry);
        emit Renewed(index, expiry);
    }

    /// @notice Delist immediately. The ENS token expires on schedule; no global unregister role.
    function remove(uint256 index) external {
        if (msg.sender != curator) revert Unauthorized();
        operators[index].active = false;
        emit Removed(index);
    }

    function setPayee(uint256 index, address payee) external {
        Operator storage op = operators[index];
        if (msg.sender != op.operator) revert Unauthorized();
        if (payee == address(0) || !op.active || op.expiry <= block.timestamp) revert InvalidOperator();
        op.payee = payee;
        emit PayeeChanged(index, payee);
    }

    function operatorCount() external view returns (uint256) { return operators.length; }
    function _validExpiry(uint64 expiry) private view {
        if (expiry <= block.timestamp || expiry > block.timestamp + MAX_LEASE) revert InvalidOperator();
    }
    function _label(bytes32 packed) private pure returns (string memory) {
        uint256 length;
        while (length < 32 && packed[length] != 0) ++length;
        bytes memory raw = new bytes(length);
        for (uint256 i; i < length; ++i) raw[i] = packed[i];
        return string(raw);
    }
}
